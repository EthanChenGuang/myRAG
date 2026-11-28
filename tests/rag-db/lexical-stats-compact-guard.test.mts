import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 1014 (T-04.4-09): rag_lexstats_compact_tenant asserts its tenant key with rag_assert_tenant_key before any other statement, so a
 * malformed key or a key of the other deployment mode is refused with 22023 and touches no row. rag_lexstats_compact_all skips such a
 * key and still compacts every valid tenant (plan 04.4-04: one stray key never stops compact_all). Neutral generated words only.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/1014_lexstats_compact_tenant_guard.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SIGNATURES = ['rag_lexstats_compact_tenant(text, integer)', 'rag_lexstats_compact_all(integer)'];
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'];

function stripComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

function functionBody(sql: string, name: string): { header: string; body: string } {
  const start = sql.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'i'));
  assert.ok(start >= 0, `${name} is not defined in 1014`);
  const rest = sql.slice(start);
  const as = /\bAS\s+(\$[a-z0-9_]*\$)/i.exec(rest);
  assert.ok(as, `${name} has no dollar-quoted body`);
  const bodyStart = as.index + as[0].length;
  const bodyEnd = rest.indexOf(as[1] as string, bodyStart);
  return { header: rest.slice(0, as.index), body: rest.slice(bodyStart, bodyEnd) };
}

describe('1014 migration file', () => {
  const sql = fs.existsSync(MIGRATION) ? stripComments(fs.readFileSync(MIGRATION, 'utf8')) : '';

  test('rag_lexstats_compact_tenant asserts the tenant key first, SECURITY INVOKER with an empty search_path', () => {
    const { header, body } = functionBody(sql, 'rag_lexstats_compact_tenant');
    assert.match(header, /\bSET\s+search_path\s*=\s*''/i);
    assert.match(header, /\bSECURITY\s+INVOKER\b/i);
    const afterBegin = body.slice((/\bBEGIN\b/i.exec(body)?.index ?? 0) + 'BEGIN'.length);
    const first = (afterBegin.split(';')[0] ?? '').replace(/\s+/g, ' ').trim();
    assert.match(first, /^PERFORM\s+public\.rag_assert_tenant_key\s*\(\s*p_tenant_key\s*\)$/i);
  });

  test('compact_all keeps an empty search_path; no SECURITY DEFINER, no dynamic SQL; grants are service_role only', () => {
    assert.match(functionBody(sql, 'rag_lexstats_compact_all').header, /\bSET\s+search_path\s*=\s*''/i);
    assert.doesNotMatch(sql, /SECURITY\s+DEFINER/i);
    assert.doesNotMatch(sql, /\bEXECUTE\s+(format|'|\$)/i);
    for (const signature of SIGNATURES) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`), signature);
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`), signature);
    }
    const grants = sql.match(/\bGRANT\b[\s\S]*?;/gi) ?? [];
    for (const grant of grants) assert.doesNotMatch(grant.split(/\bTO\b/i).slice(1).join(' '), /\b(anon|authenticated|PUBLIC)\b/i, grant);
  });
});

for (const mode of MODES) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const otherModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`1014 compact_tenant tenant guard (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid') ON CONFLICT DO NOTHING", [FIXTURE_USER_ID]);
      }
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.exec(`
        RESET ROLE;
        DELETE FROM public.rag_lexical_stats_pending;
        DELETE FROM public.rag_lexical_stats_state;
        DELETE FROM public.rag_lexical_df;
        DELETE FROM public.rag_lexical_corpus;
        DELETE FROM public.document_chunks;
        DELETE FROM public.documents;
      `);
    });

    async function asService<T>(sql: string, params: unknown[] = []): Promise<T> {
      await db.exec('SET ROLE service_role');
      try {
        return (await db.query<{ v: T }>(`SELECT ${sql} AS v`, params)).rows[0]!.v;
      } finally {
        await db.exec('RESET ROLE');
      }
    }

    async function errorOf(promise: Promise<unknown>): Promise<{ code?: string }> {
      try {
        await promise;
      } catch (error) {
        return error as { code?: string };
      }
      assert.fail('expected an error');
    }

    async function asClient(role: 'anon' | 'authenticated', sql: string, params: unknown[] = []): Promise<{ code?: string }> {
      return errorOf(
        db.transaction(async (tx) => {
          await tx.exec(`SET LOCAL ROLE ${role}`);
          if (role === 'authenticated') {
            await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: FIXTURE_USER_ID, role: 'authenticated' })]);
          }
          await tx.query(sql, params);
        }),
      );
    }

    /** Enables the tenant and stages pending rows through the 0901 triggers. */
    async function seedValidTenant(): Promise<void> {
      await asService('public.rag_lexstats_enable($1)', [tenant]);
      const docId = crypto.randomUUID();
      await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, 'guard.txt', 'neutral sample', '{}'::jsonb, $2::uuid)", [
        docId,
        FIXTURE_USER_ID,
      ]);
      await db.query(
        `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current, chunking_profile_id)
         SELECT gen_random_uuid(), $1::uuid, 'neutral sample', '{}'::jsonb, g - 1, 'w' || g || ' w0 w1', 'en', 'ready', true, 'legacy'
           FROM generate_series(1, 4) AS g`,
        [docId],
      );
    }

    /** A stray state row and pending row under a key no tenant function would accept (written directly, as only a superuser could). */
    async function seedStrayKey(key: string): Promise<void> {
      await db.query('INSERT INTO public.rag_lexical_stats_state (tenant_key) VALUES ($1)', [key]);
      await db.query(
        "INSERT INTO public.rag_lexical_stats_pending (tenant_key, corpus, chunking_profile_id, language, sign, lexemes, dl) VALUES ($1, 'chunks', 'legacy', 'en', 1, ARRAY['w0'], 1)",
        [key],
      );
    }

    async function rowsOf(key: string): Promise<string> {
      const parts: unknown[] = [];
      for (const table of STATS_TABLES) {
        parts.push((await db.query<Record<string, unknown>>(`SELECT * FROM public.${table} WHERE tenant_key = $1 ORDER BY 1, 2`, [key])).rows.map((r) => ({ ...r, created_at: null, enabled_at: null })));
      }
      return JSON.stringify(parts);
    }

    async function pending(key: string): Promise<number> {
      return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_lexical_stats_pending WHERE tenant_key = $1', [key])).rows[0]!.n;
    }

    test('a key of the other deployment mode, or a malformed one, is refused with 22023 and changes no row', async () => {
      for (const key of [otherModeKey, 'not-a-key']) {
        await seedStrayKey(key);
        const before = await rowsOf(key);
        const err = await errorOf(asService('public.rag_lexstats_compact_tenant($1, 10)', [key]));
        assert.equal(err.code, '22023', `compact_tenant(${key})`);
        assert.equal(await rowsOf(key), before, `${key}: rows unchanged`);
      }
      const nullErr = await errorOf(asService('public.rag_lexstats_compact_tenant(NULL, 10)'));
      assert.equal(nullErr.code, '22023', 'compact_tenant(NULL)');
    });

    test('anon and authenticated cannot execute either function', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const signature of SIGNATURES) {
          const ok = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${signature}`]);
          assert.equal(ok.rows[0]?.ok, false, `${role} EXECUTE ${signature}`);
        }
        assert.equal((await asClient(role, 'SELECT public.rag_lexstats_compact_tenant($1, 10)', [tenant])).code, '42501', `${role} compact_tenant`);
        assert.equal((await asClient(role, 'SELECT public.rag_lexstats_compact_all(10)')).code, '42501', `${role} compact_all`);
      }
    });

    test('the right key compacts as before: pending rows fold into the counters', async () => {
      await seedValidTenant();
      const staged = await pending(tenant);
      assert.ok(staged > 0, 'triggers staged pending rows');
      let folded = 0;
      for (let n = -1; n !== 0; folded += n) n = Number(await asService('public.rag_lexstats_compact_tenant($1, 3)', [tenant]));
      assert.equal(folded, staged);
      assert.equal(await pending(tenant), 0);
      const corpus = await db.query<{ n: number }>(
        "SELECT chunk_count::int AS n FROM public.rag_lexical_corpus WHERE tenant_key = $1 AND corpus = 'chunks' AND chunking_profile_id = 'legacy' AND language = 'en'",
        [tenant],
      );
      assert.equal(corpus.rows[0]?.n, 4);
      const check = await asService<{ clean: boolean }>('public.rag_lexstats_check($1)', [tenant]);
      assert.equal(check.clean, true);
    });

    test('compact_all skips a stray key, leaves its rows alone and still compacts the valid tenant', async () => {
      await seedValidTenant();
      await seedStrayKey(otherModeKey);
      const strayBefore = await rowsOf(otherModeKey);
      const staged = await pending(tenant);
      let total = 0;
      for (let n = -1; n !== 0; total += n) n = Number(await asService('public.rag_lexstats_compact_all(2)'));
      assert.equal(total, staged);
      assert.equal(await pending(tenant), 0);
      assert.equal(await rowsOf(otherModeKey), strayBefore);
    });

    test('applying 1014 a second time is a no-op', async () => {
      await seedValidTenant();
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      for (const signature of SIGNATURES) {
        const r = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace", [
          signature.split('(')[0],
        ]);
        assert.equal(r.rows[0]?.n, 1, signature);
      }
      assert.equal((await errorOf(asService('public.rag_lexstats_compact_tenant($1, 10)', [otherModeKey]))).code, '22023');
      const staged = await pending(tenant);
      assert.equal(Number(await asService('public.rag_lexstats_compact_tenant($1, 5000)', [tenant])), staged);
      assert.equal(await pending(tenant), 0);
    });
  });
}
