import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0903: rag_purge_hook_lexical_stats, the Phase 6.3 purge hook of the per-tenant lexical statistics (LEX-06, D-33). The counters hold
 * no document id, so the hook folds the -1 rows the delete trigger staged when the purge deleted the chunks. Neutral generated tokens
 * (w0..wN) only (D-41).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0903_lexical_stats_purge_hook.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000b2';
const SIGNATURE = 'rag_purge_hook_lexical_stats(text, uuid, uuid[])';
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'];

function words(seed: number, n: number): string {
  let state = seed >>> 0 || 1;
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out.push(`w${state % 40}`);
  }
  return out.join(' ');
}

async function createDocument(db: PGlite, userId: string, lineageId?: string, version = 1): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO public.documents (id, filename, content, metadata, user_id, lineage_id, version)
     VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, $4::uuid, $5)`,
    [id, `purge-${id}.txt`, userId, lineageId ?? id, version],
  );
  return id;
}

async function addChunks(db: PGlite, docId: string, seed: number, count: number): Promise<void> {
  const texts = Array.from({ length: count }, (_, i) => words(seed * 100 + i, 3 + (i % 6)));
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current)
     SELECT gen_random_uuid(), $1::uuid, 'neutral sample', '{}'::jsonb, u.ord::int - 1, u.txt, CASE WHEN u.ord % 3 = 0 THEN 'it' ELSE 'en' END, 'ready', true
       FROM unnest($2::text[]) WITH ORDINALITY AS u(txt, ord)`,
    [docId, texts],
  );
}

/** Deletes the chunks and rows of the listed versions, as the Phase 6.3 purge does. */
async function purgeRows(db: PGlite, docIds: string[]): Promise<void> {
  await db.query('DELETE FROM public.document_chunks WHERE document_id = ANY ($1::uuid[])', [docIds]);
  await db.query('DELETE FROM public.documents WHERE id = ANY ($1::uuid[])', [docIds]);
}

async function reset(db: PGlite): Promise<void> {
  await db.exec(`
    RESET ROLE;
    DELETE FROM public.rag_lexical_stats_pending;
    DELETE FROM public.rag_lexical_stats_state;
    DELETE FROM public.rag_lexical_df;
    DELETE FROM public.rag_lexical_corpus;
    DELETE FROM public.document_chunks;
    DELETE FROM public.documents;
  `);
}

async function rpc<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return (await db.query<{ v: T }>(`SELECT ${sql} AS v`, params)).rows[0]!.v;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function hook(db: PGlite, tenantKey: string, lineageId: string | null, docIds: string[]): Promise<number> {
  return Number(await rpc<number | string>(db, 'public.rag_purge_hook_lexical_stats($1, $2::uuid, $3::uuid[])', [tenantKey, lineageId, docIds]));
}

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  assert.fail('expected an error');
}

async function enableAndRebuild(db: PGlite, tenantKey: string): Promise<void> {
  await rpc(db, 'public.rag_lexstats_enable($1)', [tenantKey]);
  await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantKey]);
}

async function snapshot(db: PGlite, tenantKey: string): Promise<string> {
  const parts: unknown[] = [];
  for (const table of STATS_TABLES) {
    const cols = table === 'rag_lexical_stats_pending' ? 'id, corpus, chunking_profile_id, language, sign, lexemes, dl' : '*';
    parts.push((await db.query(`SELECT ${cols} FROM public.${table} WHERE tenant_key = $1 ORDER BY 1, 2, 3`, [tenantKey])).rows);
  }
  return JSON.stringify(parts);
}

async function countRows(db: PGlite, table: string, tenantKey: string): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE tenant_key = $1`, [tenantKey])).rows[0]!.n;
}

async function status(db: PGlite, tenantKey: string): Promise<{ pending: number; chunk_count: number }> {
  return rpc(db, 'public.rag_lexstats_status($1)', [tenantKey]);
}

async function assertClean(db: PGlite, tenantKey: string, label: string): Promise<void> {
  const c = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_check($1)', [tenantKey]);
  assert.equal(c.pending, 0, `${label}: pending`);
  assert.equal(c.df_mismatch, 0, `${label}: df_mismatch`);
  assert.equal(c.chunk_count_diff, 0, `${label}: chunk_count_diff`);
  assert.equal(c.total_len_diff, 0, `${label}: total_len_diff`);
  assert.equal(c.clean, true, `${label}: clean`);
}

describe('0903 migration file', () => {
  test('SECURITY INVOKER, empty search_path, guarded, folds through rag_lexstats_compact, service_role only', () => {
    const sql = fs.existsSync(MIGRATION) ? fs.readFileSync(MIGRATION, 'utf8') : '';
    assert.ok(sql.length > 0, '0903 is missing');
    assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, 0);
    assert.match(sql, /rag_assert_tenant_key/);
    assert.match(sql, /public\.rag_lexstats_compact\(/);
    assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${SIGNATURE} FROM PUBLIC, anon, authenticated;`));
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${SIGNATURE} TO service_role;`));
  });
});

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = mode === 'multi-tenant' ? `u:${SECOND_USER_ID}` : null;
  const otherModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`0903 lexical statistics purge hook (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'multi-tenant') await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'second-user@example.invalid')", [SECOND_USER_ID]);
      else await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid') ON CONFLICT DO NOTHING", [FIXTURE_USER_ID]);
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await reset(db);
    });

    test('the hook exists once, SECURITY INVOKER with an empty search_path; client roles cannot execute it', async () => {
      const r = await db.query<{ secdef: boolean; cfg: string[] | null; ret: string }>(
        `SELECT prosecdef AS secdef, proconfig AS cfg, pg_get_function_result(oid) AS ret FROM pg_proc
          WHERE proname = 'rag_purge_hook_lexical_stats' AND pronamespace = 'public'::regnamespace`,
      );
      assert.equal(r.rows.length, 1);
      assert.equal(r.rows[0]?.secdef, false);
      assert.deepEqual(r.rows[0]?.cfg, ['search_path=""']);
      assert.equal(r.rows[0]?.ret, 'bigint');
      for (const role of ['public', 'anon', 'authenticated']) {
        const ok = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${SIGNATURE}`]);
        assert.equal(ok.rows[0]?.ok, false, `${role} EXECUTE`);
      }
      const svc = await db.query<{ ok: boolean }>("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [`public.${SIGNATURE}`]);
      assert.equal(svc.rows[0]?.ok, true);
    });

    test('purging two versions: the hook folds the staged removals, check is clean, the other tenant is untouched', async () => {
      const lineage = crypto.randomUUID();
      const v1 = await createDocument(db, FIXTURE_USER_ID, lineage, 1);
      const v2 = await createDocument(db, FIXTURE_USER_ID, lineage, 2);
      const keep = await createDocument(db, FIXTURE_USER_ID);
      await addChunks(db, v1, 1, 8);
      await addChunks(db, v2, 2, 6);
      await addChunks(db, keep, 3, 5);
      await enableAndRebuild(db, tenantA);
      let bBefore = '';
      if (tenantB) {
        const other = await createDocument(db, SECOND_USER_ID);
        await addChunks(db, other, 9, 7);
        await enableAndRebuild(db, tenantB);
        await db.query("INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current) VALUES (gen_random_uuid(), $1, 'neutral sample', '{}'::jsonb, 99, 'w1 w2', 'en', 'ready', true)", [other]);
        bBefore = await snapshot(db, tenantB);
        assert.equal(await countRows(db, 'rag_lexical_stats_pending', tenantB), 1, 'tenant B has a staged row the hook must leave alone');
      }

      await purgeRows(db, [v1, v2]);
      const staged = (await status(db, tenantA)).pending;
      assert.equal(staged, 14, 'one -1 row per purged member chunk');
      assert.equal(await hook(db, tenantA, lineage, [v1, v2]), staged);
      await assertClean(db, tenantA, 'after purge and hook');
      assert.equal((await status(db, tenantA)).chunk_count, 5);
      if (tenantB) assert.equal(await snapshot(db, tenantB), bBefore, 'tenant B unchanged');
      assert.equal(await hook(db, tenantA, lineage, [v1, v2]), 0, 'idempotent');
    });

    test('purging every document of the tenant leaves no counter row of the tenant', async () => {
      const a = await createDocument(db, FIXTURE_USER_ID);
      const b = await createDocument(db, FIXTURE_USER_ID);
      await addChunks(db, a, 4, 9);
      await addChunks(db, b, 5, 4);
      await enableAndRebuild(db, tenantA);
      assert.ok((await countRows(db, 'rag_lexical_df', tenantA)) > 0);
      await purgeRows(db, [a, b]);
      assert.equal(await hook(db, tenantA, null, [a, b]), 13);
      assert.equal(await countRows(db, 'rag_lexical_df', tenantA), 0);
      assert.equal(await countRows(db, 'rag_lexical_corpus', tenantA), 0);
      assert.equal(await countRows(db, 'rag_lexical_stats_pending', tenantA), 0);
      await assertClean(db, tenantA, 'empty tenant');
    });

    test('Phase 6.3 order (hook before the chunk delete) needs the second call after the delete', async () => {
      const doc = await createDocument(db, FIXTURE_USER_ID);
      const keep = await createDocument(db, FIXTURE_USER_ID);
      await addChunks(db, doc, 6, 5);
      await addChunks(db, keep, 7, 3);
      await enableAndRebuild(db, tenantA);

      assert.equal(await hook(db, tenantA, null, [doc]), 0, 'nothing staged yet');
      assert.equal((await status(db, tenantA)).pending, 0, 'after the first call alone');
      await purgeRows(db, [doc]);
      assert.equal((await status(db, tenantA)).pending, 5, 'after the delete alone the removals are staged');
      const c = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_check($1)', [tenantA]);
      assert.ok(Number(c.df_mismatch) > 0, 'counters alone still carry the purged vocabulary');
      assert.equal(await hook(db, tenantA, null, [doc]), 5, 'the second call folds them');
      await assertClean(db, tenantA, 'after the second call');
      assert.equal((await status(db, tenantA)).pending, 0);
    });

    test('ids of another lineage are refused (22023) and nothing changes; ids that no longer exist are accepted', async () => {
      const lineage = crypto.randomUUID();
      const doc = await createDocument(db, FIXTURE_USER_ID, lineage, 1);
      const elsewhere = await createDocument(db, FIXTURE_USER_ID);
      await addChunks(db, doc, 8, 4);
      await addChunks(db, elsewhere, 10, 3);
      await enableAndRebuild(db, tenantA);
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [elsewhere]);
      const before = await snapshot(db, tenantA);
      assert.equal(await sqlState(hook(db, tenantA, lineage, [doc, elsewhere])), '22023');
      assert.equal(await snapshot(db, tenantA), before, 'nothing folded after a refusal');
      assert.equal(await hook(db, tenantA, lineage, [crypto.randomUUID()]), 3, 'a gone id is accepted; the staged rows are folded');
      await assertClean(db, tenantA, 'after the accepted call');
    });

    if (tenantB) {
      test("an id of another tenant's document is refused (22023) and nothing changes", async () => {
        const mine = await createDocument(db, FIXTURE_USER_ID);
        const theirs = await createDocument(db, SECOND_USER_ID);
        await addChunks(db, mine, 11, 3);
        await addChunks(db, theirs, 12, 3);
        await enableAndRebuild(db, tenantA);
        await enableAndRebuild(db, tenantB);
        await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [mine]);
        const [aBefore, bBefore] = [await snapshot(db, tenantA), await snapshot(db, tenantB)];
        assert.equal(await sqlState(hook(db, tenantA, null, [mine, theirs])), '22023');
        assert.equal(await snapshot(db, tenantA), aBefore);
        assert.equal(await snapshot(db, tenantB), bBefore);
      });
    }

    test('a tenant without a state row: returns 0 and writes nothing', async () => {
      const doc = await createDocument(db, FIXTURE_USER_ID);
      await addChunks(db, doc, 13, 4);
      await purgeRows(db, [doc]);
      assert.equal(await hook(db, tenantA, null, [doc]), 0);
      for (const table of STATS_TABLES) assert.equal(await countRows(db, table, tenantA), 0, table);
    });

    test('a key of the other deployment mode or a malformed key is rejected (22023)', async () => {
      for (const key of [otherModeKey, 'not-a-key']) {
        assert.equal(await sqlState(hook(db, key, null, [])), '22023', key);
      }
    });

    test('applying 0903 a second time is a no-op', async () => {
      const doc = await createDocument(db, FIXTURE_USER_ID);
      await addChunks(db, doc, 14, 4);
      await enableAndRebuild(db, tenantA);
      const before = await snapshot(db, tenantA);
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'rag_purge_hook_lexical_stats'");
      assert.equal(n.rows[0]?.n, 1);
      assert.equal(await snapshot(db, tenantA), before);
      const svc = await db.query<{ ok: boolean }>("SELECT has_function_privilege('anon', $1, 'EXECUTE') AS ok", [`public.${SIGNATURE}`]);
      assert.equal(svc.rows[0]?.ok, false);
    });
  });
}
