import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0902: maintenance RPCs of the per-tenant lexical statistics (D-17, D-18, D-19, D-32, D-34): enable, compact, compact_all, rebuild,
 * status, check and disable. Counters must equal a recompute from the member chunks after compaction, per tenant, and no call on one
 * tenant may change another. Tokens are neutral generated words (w0..wN) drawn from a seeded Zipf distribution (D-41).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0902_lexical_stats_functions.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000b2';
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'];
const SIGNATURES = [
  'rag_lexstats_enable(text)',
  'rag_lexstats_disable(text)',
  'rag_lexstats_rebuild(text)',
  'rag_lexstats_compact(text, integer)',
  'rag_lexstats_compact_all(integer)',
  'rag_lexstats_status(text)',
  'rag_lexstats_check(text)',
];
const TENANT_FUNCTIONS = SIGNATURES.filter((s) => s.startsWith('rag_lexstats_') && s.includes('(text'));

function zipfWords(seed: number, n: number, vocabulary = 60): string {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const weights = Array.from({ length: vocabulary }, (_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    let r = next() * total;
    let i = 0;
    while (i < vocabulary - 1 && r > weights[i]!) {
      r -= weights[i]!;
      i++;
    }
    out.push(`w${i}`);
  }
  return out.join(' ');
}

interface ChunkSpec {
  text: string | null;
  language?: string | null;
  status?: string;
  isCurrent?: boolean;
  profile?: string;
}

async function createDocument(db: PGlite, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid)", [
    id,
    `lexstats-${id}.txt`,
    userId,
  ]);
  return id;
}

async function insertChunks(db: PGlite, docId: string, specs: ChunkSpec[]): Promise<string[]> {
  const ids = specs.map(() => crypto.randomUUID());
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current, chunking_profile_id)
     SELECT u.id, $1::uuid, 'neutral sample', '{}'::jsonb, u.ord::int - 1, u.txt, u.lang, u.status, u.cur, u.profile
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[]) WITH ORDINALITY AS u(id, txt, lang, status, cur, profile, ord)`,
    [
      docId,
      ids,
      specs.map((s) => s.text),
      specs.map((s) => (s.language === undefined ? 'en' : s.language)),
      specs.map((s) => s.status ?? 'ready'),
      specs.map((s) => s.isCurrent ?? true),
      specs.map((s) => s.profile ?? 'legacy'),
    ],
  );
  return ids;
}

/** Seeds `count` member chunks (plus a few non-members) over two languages and two profiles. */
async function seedTenant(db: PGlite, userId: string, seed: number, count: number): Promise<{ docId: string; ids: string[] }> {
  const docId = await createDocument(db, userId);
  const specs: ChunkSpec[] = [];
  for (let i = 0; i < count; i++) {
    specs.push({
      text: zipfWords(seed * 1000 + i, 4 + ((seed + i) % 9)),
      language: i % 7 === 0 ? null : i % 3 === 0 ? 'it' : 'en',
      profile: i % 5 === 0 ? 'probe-profile' : 'legacy',
      status: i % 11 === 0 ? 'variant' : 'ready',
    });
  }
  specs.push({ text: zipfWords(seed + 7, 5), status: 'quarantined' }, { text: zipfWords(seed + 8, 5), isCurrent: false }, { text: '' });
  return { docId, ids: await insertChunks(db, docId, specs) };
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

/** Runs one RPC as service_role, the only role granted the functions. */
async function rpc<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return (await db.query<{ v: T }>(`SELECT ${sql} AS v`, params)).rows[0]!.v;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function compactUntilZero(db: PGlite, tenantKey: string, maxRows: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const n = Number(await rpc<number>(db, 'public.rag_lexstats_compact($1, $2)', [tenantKey, maxRows]));
    if (n === 0) return total;
    total += n;
  }
  throw new Error('compaction did not converge');
}

type Row = Record<string, string | number>;

async function counters(db: PGlite, tenantKey: string): Promise<{ df: Row[]; corpus: Row[] }> {
  const df = (
    await db.query<Row>(
      `SELECT lexeme, chunking_profile_id, language, df::int AS df FROM public.rag_lexical_df
        WHERE tenant_key = $1 AND corpus = 'chunks' ORDER BY lexeme, chunking_profile_id, language`,
      [tenantKey],
    )
  ).rows;
  const corpus = (
    await db.query<Row>(
      `SELECT chunking_profile_id, language, chunk_count::int AS chunk_count, total_len::int AS total_len FROM public.rag_lexical_corpus
        WHERE tenant_key = $1 AND corpus = 'chunks' ORDER BY chunking_profile_id, language`,
      [tenantKey],
    )
  ).rows;
  return { df, corpus };
}

/** Independent recompute over the member chunks (D-11). */
async function recompute(db: PGlite, tenantKey: string): Promise<{ df: Row[]; corpus: Row[] }> {
  const member = `c.tenant_key = $1 AND c.is_current AND c.status IN ('ready', 'variant') AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::tsvector`;
  const df = (
    await db.query<Row>(
      `SELECT u.lexeme, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, count(*)::int AS df
         FROM public.document_chunks c CROSS JOIN LATERAL unnest(tsvector_to_array(c.lexical_tsv)) AS u(lexeme)
        WHERE ${member} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [tenantKey],
    )
  ).rows;
  const corpus = (
    await db.query<Row>(
      `SELECT c.chunking_profile_id, COALESCE(c.language, 'und') AS language, count(*)::int AS chunk_count,
              sum((SELECT sum(cardinality(x.positions)) FROM unnest(c.lexical_tsv) x))::int AS total_len
         FROM public.document_chunks c WHERE ${member} GROUP BY 1, 2 ORDER BY 1, 2`,
      [tenantKey],
    )
  ).rows;
  return { df, corpus };
}

interface Check {
  state: string | null;
  pending: number;
  df_mismatch: number;
  df_mismatch_with_pending: number;
  chunk_count_diff: number;
  chunk_count_diff_with_pending: number;
  total_len_diff: number;
  total_len_diff_with_pending: number;
  clean: boolean;
}

async function check(db: PGlite, tenantKey: string): Promise<Check> {
  return rpc<Check>(db, 'public.rag_lexstats_check($1)', [tenantKey]);
}

function assertClean(c: Check, label: string): void {
  assert.equal(c.pending, 0, `${label}: pending`);
  assert.equal(c.df_mismatch, 0, `${label}: df_mismatch`);
  assert.equal(c.df_mismatch_with_pending, 0, `${label}: df_mismatch_with_pending`);
  assert.equal(c.chunk_count_diff, 0, `${label}: chunk_count_diff`);
  assert.equal(c.chunk_count_diff_with_pending, 0, `${label}: chunk_count_diff_with_pending`);
  assert.equal(c.total_len_diff, 0, `${label}: total_len_diff`);
  assert.equal(c.total_len_diff_with_pending, 0, `${label}: total_len_diff_with_pending`);
  assert.equal(c.clean, true, `${label}: clean`);
}

async function snapshot(db: PGlite, tenantKey: string): Promise<string> {
  const parts: unknown[] = [];
  for (const table of STATS_TABLES) {
    const cols = table === 'rag_lexical_stats_pending' ? 'id, corpus, chunking_profile_id, language, sign, lexemes, dl' : '*';
    parts.push((await db.query(`SELECT ${cols} FROM public.${table} WHERE tenant_key = $1 ORDER BY 1, 2, 3`, [tenantKey])).rows);
  }
  return JSON.stringify(parts);
}

async function sqlState(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  assert.fail('expected an error');
}

describe('0902 migration file', () => {
  test('every function is SECURITY INVOKER with an empty search_path, guarded and service_role only; no dynamic SQL', () => {
    const sql = fs.existsSync(MIGRATION) ? fs.readFileSync(MIGRATION, 'utf8') : '';
    assert.ok(sql.length > 0, '0902 is missing');
    assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, 0);
    assert.doesNotMatch(sql, /\bEXECUTE\s+(format|'|\$)/i);
    assert.ok((sql.match(/rag_assert_tenant_key/g) ?? []).length >= 6);
    assert.ok((sql.match(/pg_advisory_xact_lock/g) ?? []).length >= 3);
    for (const signature of SIGNATURES) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`), signature);
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`), signature);
    }
  });
});

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = mode === 'multi-tenant' ? `u:${SECOND_USER_ID}` : null;
  const otherModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`0902 lexical statistics maintenance (${mode})`, () => {
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

    test('the seven functions exist once each, SECURITY INVOKER with an empty search_path; client roles cannot execute them', async () => {
      for (const signature of SIGNATURES) {
        const name = signature.split('(')[0]!;
        const r = await db.query<{ secdef: boolean; cfg: string[] | null }>(
          "SELECT prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace",
          [name],
        );
        assert.equal(r.rows.length, 1, `${signature}: exactly one function`);
        assert.equal(r.rows[0]?.secdef, false, signature);
        assert.deepEqual(r.rows[0]?.cfg, ['search_path=""'], signature);
        for (const role of ['public', 'anon', 'authenticated']) {
          const ok = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${signature}`]);
          assert.equal(ok.rows[0]?.ok, false, `${role} EXECUTE ${signature}`);
        }
        const svc = await db.query<{ ok: boolean }>("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [`public.${signature}`]);
        assert.equal(svc.rows[0]?.ok, true, `service_role EXECUTE ${signature}`);
      }
    });

    test('applying 0902 a second time is a no-op', async () => {
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      for (const signature of SIGNATURES) {
        const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace", [
          signature.split('(')[0],
        ]);
        assert.equal(n.rows[0]?.n, 1, signature);
      }
      assert.equal((await rpc<{ state: string }>(db, 'public.rag_lexstats_status($1)', [tenantA])).state, 'building');
    });

    test('a tenant key of the other deployment mode, or a malformed one, is rejected by every tenant function', async () => {
      for (const signature of TENANT_FUNCTIONS) {
        const name = signature.split('(')[0]!;
        for (const key of [otherModeKey, 'not-a-key']) {
          const err = await sqlState(rpc(db, `public.${name}($1)`, [key]));
          assert.equal(err.code, '22023', `${name}(${key})`);
        }
      }
      assert.deepEqual(
        await Promise.all(STATS_TABLES.map(async (t) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0]!.n)),
        [0, 0, 0, 0],
      );
    });

    test('rebuild without enable raises lexical_stats_not_enabled (55000)', async () => {
      const err = await sqlState(rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]));
      assert.equal(err.code, '55000');
      assert.match(err.message ?? '', /lexical_stats_not_enabled/);
    });

    test('enable is idempotent and never resets a ready tenant to building', async () => {
      assert.equal(await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]), 'building');
      assert.equal(await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]), 'building');
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assert.equal(await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]), 'ready');
      assert.equal((await rpc<{ state: string }>(db, 'public.rag_lexstats_status($1)', [tenantA])).state, 'ready');
    });

    test('enable then rebuild on 200 member chunks equals the recompute; status and check report counts only', async () => {
      await seedTenant(db, FIXTURE_USER_ID, 1, 200);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      const built = await rpc<Record<string, number>>(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assert.equal(built.chunk_count, 200);
      const expected = await recompute(db, tenantA);
      assert.deepEqual(await counters(db, tenantA), expected);
      assert.equal(built.lexeme_rows, expected.df.length);
      assertClean(await check(db, tenantA), 'after rebuild');

      const status = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_status($1)', [tenantA]);
      assert.deepEqual(Object.keys(status).sort(), [
        'chunk_count',
        'compacted_at',
        'enabled_at',
        'lexeme_count',
        'oldest_pending_age_s',
        'pending',
        'rebuilt_at',
        'state',
      ]);
      assert.equal(status.state, 'ready');
      assert.equal(status.chunk_count, 200);
      assert.equal(status.lexeme_count, new Set(expected.df.map((r) => r.lexeme)).size);
      assert.equal(status.pending, 0);
      assert.equal(status.oldest_pending_age_s, null);
      assert.ok(status.rebuilt_at && status.enabled_at);
      const text = JSON.stringify([status, await check(db, tenantA)]);
      assert.doesNotMatch(text, /"w\d+"/, 'no lexeme in status or check');
    });

    test('status of a tenant that never enabled has state null and zero counts', async () => {
      const status = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_status($1)', [tenantA]);
      assert.equal(status.state, null);
      assert.equal(status.chunk_count, 0);
      assert.equal(status.pending, 0);
      const c = await check(db, tenantA);
      assert.equal(c.state, null);
      assert.equal(c.clean, null);
    });

    test('mixed changes after the rebuild: check sees the backlog, compaction in batches of 3 converges to the recompute', async () => {
      const a = await seedTenant(db, FIXTURE_USER_ID, 2, 40);
      const second = await seedTenant(db, FIXTURE_USER_ID, 3, 6);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      let bBefore = '';
      if (tenantB) {
        await seedTenant(db, SECOND_USER_ID, 9, 12);
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenantB]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantB]);
        bBefore = await snapshot(db, tenantB);
      }

      const [c0, c1, c2, c3, c4, c5, c6] = a.ids as [string, string, string, string, string, string, string];
      await insertChunks(db, a.docId, [{ text: 'w1 w2 w50 w51' }, { text: 'w3 w52', language: 'it' }]);
      await db.query('UPDATE public.document_chunks SET lexical_text = $1 WHERE id = $2', ['w53 w54 w53', c0]);
      await db.query('UPDATE public.document_chunks SET is_current = false WHERE id = $1', [c1]);
      await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE id = $1", [c2]);
      await db.query("UPDATE public.document_chunks SET status = 'ready' WHERE id = $1", [c2]);
      await db.query("UPDATE public.document_chunks SET language = 'it' WHERE id = $1", [c3]);
      await db.query("UPDATE public.document_chunks SET chunking_profile_id = 'probe-profile' WHERE id = $1", [c4]);
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [c5]);
      await db.query("UPDATE public.document_chunks SET lexical_text = 'w55' WHERE id = $1", [c6]);
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [second.docId]);
      await db.query('DELETE FROM public.documents WHERE id = $1', [second.docId]);

      const before = await check(db, tenantA);
      assert.ok(before.pending > 0, 'pending backlog');
      assert.ok(before.df_mismatch > 0, 'counters alone differ');
      assert.ok(before.chunk_count_diff > 0, 'counters alone chunk count differs');
      assert.ok(before.total_len_diff > 0, 'counters alone length differs');
      assert.equal(before.df_mismatch_with_pending, 0);
      assert.equal(before.chunk_count_diff_with_pending, 0);
      assert.equal(before.total_len_diff_with_pending, 0);
      assert.equal(before.clean, true, 'counters plus pending is no drift');

      const folded = await compactUntilZero(db, tenantA, 3);
      assert.equal(folded, before.pending);
      assert.deepEqual(await counters(db, tenantA), await recompute(db, tenantA));
      assertClean(await check(db, tenantA), 'after compaction');
      const nonPositive = await db.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM public.rag_lexical_df WHERE df <= 0) + (SELECT count(*) FROM public.rag_lexical_corpus WHERE chunk_count <= 0) AS n`,
      );
      assert.equal(Number(nonPositive.rows[0]?.n), 0);
      const status = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_status($1)', [tenantA]);
      assert.ok(status.compacted_at, 'compacted_at stamped');
      if (tenantB) assert.equal(await snapshot(db, tenantB), bBefore, 'tenant B unchanged');
    });

    test('deleting every chunk and compacting leaves no counter row of the tenant', async () => {
      const a = await seedTenant(db, FIXTURE_USER_ID, 4, 20);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [a.docId]);
      await compactUntilZero(db, tenantA, 7);
      const c = await counters(db, tenantA);
      assert.deepEqual(c, { df: [], corpus: [] });
      assertClean(await check(db, tenantA), 'empty tenant');
    });

    test('a pending row created after the rebuild snapshot is counted exactly once', async () => {
      const a = await seedTenant(db, FIXTURE_USER_ID, 5, 10);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      // Changes staged while building are part of the scan; the rebuild removes their pending rows.
      await insertChunks(db, a.docId, [{ text: 'w40 w41' }]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assert.equal((await check(db, tenantA)).pending, 0);
      assertClean(await check(db, tenantA), 'rebuild folded the building backlog');

      await insertChunks(db, a.docId, [{ text: 'w42 w43 w42' }]);
      assert.equal((await check(db, tenantA)).pending, 1);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assert.equal((await check(db, tenantA)).pending, 0);
      await compactUntilZero(db, tenantA, 5);
      const df42 = (await counters(db, tenantA)).df.filter((r) => r.lexeme === 'w42');
      assert.deepEqual(
        df42.map((r) => r.df),
        [1],
      );
      assertClean(await check(db, tenantA), 'counted once');
    });

    test('compaction of a tenant without a state row returns 0; compact_all folds every enabled tenant and returns the total', async () => {
      assert.equal(Number(await rpc(db, 'public.rag_lexstats_compact($1, 10)', [tenantA])), 0);
      const a = await seedTenant(db, FIXTURE_USER_ID, 6, 8);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      await insertChunks(db, a.docId, [{ text: 'w30' }, { text: 'w31' }, { text: 'w32' }]);
      let expected = 3;
      if (tenantB) {
        const b = await seedTenant(db, SECOND_USER_ID, 7, 5);
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenantB]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantB]);
        await db.query('DELETE FROM public.document_chunks WHERE id = ANY($1::uuid[])', [b.ids.slice(0, 2)]);
        expected += 2;
      }
      assert.equal(Number(await rpc(db, 'public.rag_lexstats_compact_all(2)')), expected);
      assert.equal(Number(await rpc(db, 'public.rag_lexstats_compact_all(2)')), 0);
      assertClean(await check(db, tenantA), 'A after compact_all');
      if (tenantB) assertClean(await check(db, tenantB), 'B after compact_all');
    });

    test('p_max_rows is bounded: 0 or negative still folds at least one row', async () => {
      const a = await seedTenant(db, FIXTURE_USER_ID, 8, 3);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      await insertChunks(db, a.docId, [{ text: 'w20' }, { text: 'w21' }]);
      assert.equal(Number(await rpc(db, 'public.rag_lexstats_compact($1, 0)', [tenantA])), 1);
      assert.equal(Number(await rpc(db, 'public.rag_lexstats_compact($1, -5)', [tenantA])), 1);
      assert.equal(Number(await rpc(db, 'public.rag_lexstats_compact($1, NULL)', [tenantA])), 0);
    });

    test('disable removes every row of the tenant from the four tables; later writes stage nothing', async () => {
      const a = await seedTenant(db, FIXTURE_USER_ID, 10, 15);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      await insertChunks(db, a.docId, [{ text: 'w11 w12' }]);
      let bBefore = '';
      if (tenantB) {
        await seedTenant(db, SECOND_USER_ID, 11, 6);
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenantB]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantB]);
        bBefore = await snapshot(db, tenantB);
      }
      assert.equal(await rpc(db, 'public.rag_lexstats_disable($1)', [tenantA]), true);
      for (const table of STATS_TABLES) {
        const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE tenant_key = $1`, [tenantA]);
        assert.equal(n.rows[0]?.n, 0, table);
      }
      await insertChunks(db, a.docId, [{ text: 'w13' }]);
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [a.ids[0]]);
      const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_lexical_stats_pending WHERE tenant_key = $1', [tenantA]);
      assert.equal(n.rows[0]?.n, 0);
      assert.equal(await rpc(db, 'public.rag_lexstats_disable($1)', [tenantA]), false);
      if (tenantB) assert.equal(await snapshot(db, tenantB), bBefore, 'tenant B unchanged by disable of A');
    });

    if (tenantB) {
      test('every operation on tenant A leaves tenant B byte for byte unchanged', async () => {
        await seedTenant(db, SECOND_USER_ID, 12, 10);
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenantB]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantB]);
        const b = await createDocument(db, SECOND_USER_ID);
        await insertChunks(db, b, [{ text: 'w1 w2' }]);
        const bBefore = await snapshot(db, tenantB);
        const a = await seedTenant(db, FIXTURE_USER_ID, 13, 10);
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
        await insertChunks(db, a.docId, [{ text: 'w1 w2' }]);
        await rpc(db, 'public.rag_lexstats_compact($1, 100)', [tenantA]);
        await rpc(db, 'public.rag_lexstats_status($1)', [tenantA]);
        await rpc(db, 'public.rag_lexstats_check($1)', [tenantA]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
        await rpc(db, 'public.rag_lexstats_disable($1)', [tenantA]);
        assert.equal(await snapshot(db, tenantB), bBefore);
      });
    }
  });
}
