import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0905 (plan 04.4-16): cluster-aware BM25 document frequency statistics, corpus 'chunks_cluster' (D-46 to D-48). A member chunk
 * without a cluster is one unit; per (tenant, cluster, chunking profile, language) the member with the smallest id is the unit. The
 * triggers stage signed pending rows for cluster-less members and one marker per cluster a changed chunk left or joined; compaction
 * folds and reconciles against the ledger; rag_lexstats_check tests the two invariants. Tokens are neutral generated words (D-41).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0905_lexical_cluster_df.sql');
const MIGRATION_0901 = path.join(REPO_ROOT, 'supabase/migrations/0901_lexical_stats_triggers.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000000c2';
const CLUSTER_TABLES = ['rag_lexical_cluster_dirty', 'rag_lexical_cluster_units'];
const STATS_TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus', ...CLUSTER_TABLES];
const NEW_FUNCTIONS = ['rag_lexstats_cluster_enable(text)', 'rag_lexstats_cluster_disable(text)'];

function words(seed: number, n: number): string {
  return Array.from({ length: n }, (_, i) => `w${(seed * 7 + i * 3) % 29}`).join(' ');
}

interface ChunkSpec {
  text: string | null;
  language?: string | null;
  status?: string;
  isCurrent?: boolean;
  profile?: string;
  cluster?: string | null;
}

type Row = Record<string, unknown>;

async function createDocument(db: PGlite, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid)", [
    id,
    `cluster-df-${id}.txt`,
    userId,
  ]);
  return id;
}

/** Inserts all specs of one document in one statement; ids are returned in order. */
async function insertChunks(db: PGlite, docId: string, specs: ChunkSpec[], ids: string[] = specs.map(() => crypto.randomUUID())): Promise<string[]> {
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, status, is_current,
       chunking_profile_id, dup_cluster_id)
     SELECT u.id, $1::uuid, 'neutral sample', '{}'::jsonb, u.ord::int - 1, u.txt, u.lang, u.status, u.cur, u.profile, u.cluster
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::text[], $8::uuid[])
            WITH ORDINALITY AS u(id, txt, lang, status, cur, profile, cluster, ord)`,
    [
      docId,
      ids,
      specs.map((s) => s.text),
      specs.map((s) => (s.language === undefined ? 'en' : s.language)),
      specs.map((s) => s.status ?? 'ready'),
      specs.map((s) => s.isCurrent ?? true),
      specs.map((s) => s.profile ?? 'legacy'),
      specs.map((s) => s.cluster ?? null),
    ],
  );
  return ids;
}

async function newCluster(db: PGlite, tenantKey: string): Promise<string> {
  return (
    await db.query<{ id: string }>("INSERT INTO public.rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, 'openai-3-small-1536') RETURNING id", [
      tenantKey,
    ])
  ).rows[0]!.id;
}

async function setCluster(db: PGlite, chunkIds: string[], clusterId: string | null): Promise<void> {
  await db.query('UPDATE public.document_chunks SET dup_cluster_id = $2::uuid WHERE id = ANY ($1::uuid[])', [chunkIds, clusterId]);
}

async function reset(db: PGlite): Promise<void> {
  await db.exec(`
    RESET ROLE;
    DELETE FROM public.rag_lexical_cluster_dirty;
    DELETE FROM public.rag_lexical_cluster_units;
    DELETE FROM public.rag_lexical_stats_pending;
    DELETE FROM public.rag_lexical_stats_state;
    DELETE FROM public.rag_lexical_df;
    DELETE FROM public.rag_lexical_corpus;
    UPDATE public.document_chunks SET dup_cluster_id = NULL WHERE dup_cluster_id IS NOT NULL;
    DELETE FROM public.rag_dup_clusters;
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

async function compactUntilZero(db: PGlite, tenantKey: string, maxRows = 5000): Promise<number> {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const n = Number(await rpc<number>(db, 'public.rag_lexstats_compact($1, $2)', [tenantKey, maxRows]));
    if (n === 0) return total;
    total += n;
  }
  throw new Error('compaction did not converge');
}

async function enableCluster(db: PGlite, tenantKey: string): Promise<void> {
  await rpc(db, 'public.rag_lexstats_enable($1)', [tenantKey]);
  await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantKey]);
  await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantKey]);
}

async function counters(db: PGlite, tenantKey: string, corpus: string): Promise<{ df: Row[]; corpus: Row[] }> {
  const df = (
    await db.query<Row>(
      `SELECT lexeme, chunking_profile_id, language, df::int AS df FROM public.rag_lexical_df
        WHERE tenant_key = $1 AND corpus = $2 ORDER BY lexeme, chunking_profile_id, language`,
      [tenantKey, corpus],
    )
  ).rows;
  const c = (
    await db.query<Row>(
      `SELECT chunking_profile_id, language, chunk_count::int AS chunk_count, total_len::int AS total_len FROM public.rag_lexical_corpus
        WHERE tenant_key = $1 AND corpus = $2 ORDER BY chunking_profile_id, language`,
      [tenantKey, corpus],
    )
  ).rows;
  return { df, corpus: c };
}

const MEMBER = `c.tenant_key = $1 AND c.is_current AND c.status IN ('ready', 'variant') AND c.lexical_tsv IS NOT NULL AND c.lexical_tsv <> ''::tsvector`;

/** Independent recompute of the units (D-46): cluster-less members plus the smallest-id member per cluster key. */
const UNITS = `
  SELECT c.id, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv FROM public.document_chunks c
   WHERE ${MEMBER} AND c.dup_cluster_id IS NULL
  UNION ALL
  SELECT q.id, q.chunking_profile_id, q.language, q.lexical_tsv FROM (
    SELECT c.id, c.chunking_profile_id, COALESCE(c.language, 'und') AS language, c.lexical_tsv,
           row_number() OVER (PARTITION BY c.dup_cluster_id, c.chunking_profile_id, COALESCE(c.language, 'und') ORDER BY c.id) AS rn
      FROM public.document_chunks c WHERE ${MEMBER} AND c.dup_cluster_id IS NOT NULL) q
   WHERE q.rn = 1`;

async function recomputeUnits(db: PGlite, tenantKey: string): Promise<{ df: Row[]; corpus: Row[] }> {
  const df = (
    await db.query<Row>(
      `SELECT u.lexeme, x.chunking_profile_id, x.language, count(*)::int AS df
         FROM (${UNITS}) x CROSS JOIN LATERAL unnest(tsvector_to_array(x.lexical_tsv)) AS u(lexeme)
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      [tenantKey],
    )
  ).rows;
  const c = (
    await db.query<Row>(
      `SELECT x.chunking_profile_id, x.language, count(*)::int AS chunk_count,
              sum((SELECT sum(cardinality(p.positions)) FROM unnest(x.lexical_tsv) p))::int AS total_len
         FROM (${UNITS}) x GROUP BY 1, 2 ORDER BY 1, 2`,
      [tenantKey],
    )
  ).rows;
  return { df, corpus: c };
}

async function ledger(db: PGlite, tenantKey: string): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT dup_cluster_id, chunking_profile_id, language, chunk_id, lexemes, dl FROM public.rag_lexical_cluster_units
        WHERE tenant_key = $1 ORDER BY dup_cluster_id, chunking_profile_id, language`,
      [tenantKey],
    )
  ).rows;
}

async function count(db: PGlite, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`, params)).rows[0]!.n;
}

interface Check {
  clean: boolean;
  pending: number;
  cluster_status?: string;
  cluster_dirty?: number;
  cluster_df_diff?: number;
  cluster_chunk_count_diff?: number;
  cluster_total_len_diff?: number;
  cluster_ledger_diff?: number;
  df_mismatch_with_pending: number;
}

async function check(db: PGlite, tenantKey: string): Promise<Check> {
  return rpc<Check>(db, 'public.rag_lexstats_check($1)', [tenantKey]);
}

function assertClusterClean(c: Check, label: string): void {
  assert.equal(c.cluster_df_diff, 0, `${label}: cluster_df_diff`);
  assert.equal(c.cluster_chunk_count_diff, 0, `${label}: cluster_chunk_count_diff`);
  assert.equal(c.cluster_total_len_diff, 0, `${label}: cluster_total_len_diff`);
  assert.equal(c.cluster_ledger_diff, 0, `${label}: cluster_ledger_diff`);
  assert.equal(c.df_mismatch_with_pending, 0, `${label}: df_mismatch_with_pending`);
  assert.equal(c.clean, true, `${label}: clean`);
}

/** Compacts, then asserts both corpora equal their recomputes, the drift check is clean and no marker is left. */
async function assertSettled(db: PGlite, tenantKey: string, label: string): Promise<void> {
  await compactUntilZero(db, tenantKey);
  const c = await check(db, tenantKey);
  assertClusterClean(c, label);
  assert.equal(c.pending, 0, `${label}: pending`);
  assert.equal(c.cluster_dirty, 0, `${label}: cluster_dirty`);
  assert.deepEqual(await counters(db, tenantKey, 'chunks_cluster'), await recomputeUnits(db, tenantKey), `${label}: chunks_cluster counters`);
}

const seen = { pending: 0, marker: 0 };

/** The cluster rows staged since the previous call (rows are never deleted here, so the invariants keep holding). */
async function stagedCluster(db: PGlite): Promise<{ pending: Row[]; markers: Row[] }> {
  const pending = (
    await db.query<Row & { id: number }>(
      `SELECT id::int AS id, tenant_key, chunking_profile_id, language, sign::int AS sign, lexemes, dl FROM public.rag_lexical_stats_pending
        WHERE corpus = 'chunks_cluster' AND id > $1 ORDER BY id`,
      [seen.pending],
    )
  ).rows;
  const markers = (
    await db.query<Row & { id: number }>('SELECT id::int AS id, tenant_key, dup_cluster_id FROM public.rag_lexical_cluster_dirty WHERE id > $1 ORDER BY id', [seen.marker])
  ).rows;
  await markSeen(db);
  return { pending: pending.map(({ id: _id, ...rest }) => rest), markers: markers.map(({ id: _id, ...rest }) => rest) };
}

async function markSeen(db: PGlite): Promise<void> {
  seen.pending = (await db.query<{ n: number }>('SELECT COALESCE(max(id), 0)::int AS n FROM public.rag_lexical_stats_pending')).rows[0]!.n;
  seen.marker = (await db.query<{ n: number }>('SELECT COALESCE(max(id), 0)::int AS n FROM public.rag_lexical_cluster_dirty')).rows[0]!.n;
}

function sorted(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function lexemes(text: string): string[] {
  return [...new Set(text.split(' ').filter(Boolean))].sort();
}

async function sqlError(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  assert.fail('expected an error');
}

describe('0905 migration file', () => {
  test('header, precheck, re-run rule, empty search_path everywhere, no new definer function, service_role only, no dynamic SQL', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    assert.match(sql, /after re-running 0901, 0902 or 0903, re-run this file/);
    assert.match(sql, /ERRCODE = '55000'/);
    assert.doesNotMatch(sql, /\bEXECUTE\s+(format|'|\$)/i);
    const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(([^)]*)\)/g)];
    assert.ok(functions.length >= 12, 'functions');
    const bodies = sql.split(/CREATE OR REPLACE FUNCTION /).slice(1);
    for (const body of bodies) {
      const head = body.slice(0, body.indexOf('AS $fn$'));
      assert.match(head, /SET search_path = ''/, head.split('\n')[0]);
      if (/SECURITY DEFINER/.test(head)) assert.match(head, /^public\.rag_lexstats_chunks_(insert|update|delete)\(\)/, 'only the three trigger functions are definer');
    }
    for (const signature of NEW_FUNCTIONS) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`), signature);
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`), signature);
    }
    for (const table of CLUSTER_TABLES) {
      assert.ok(sql.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`), table);
      assert.ok(sql.includes(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`), table);
      assert.doesNotMatch(sql, new RegExp(`CREATE POLICY[^;]*${table}`), table);
    }
  });
});

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = mode === 'multi-tenant' ? `u:${SECOND_USER_ID}` : null;
  const otherModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`0905 cluster-aware lexical statistics (${mode})`, () => {
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

    test('applying 0905 twice is a no-op; the new tables and functions are closed to client roles; RLS is on', async () => {
      await enableCluster(db, tenantA);
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      const state = await db.query<{ cluster_status: string }>('SELECT cluster_status FROM public.rag_lexical_stats_state WHERE tenant_key = $1', [tenantA]);
      assert.equal(state.rows[0]?.cluster_status, 'ready');
      for (const signature of NEW_FUNCTIONS) {
        const name = signature.split('(')[0]!;
        const r = await db.query<{ secdef: boolean; cfg: string[] | null }>(
          "SELECT prosecdef AS secdef, proconfig AS cfg FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace",
          [name],
        );
        assert.equal(r.rows.length, 1, signature);
        assert.equal(r.rows[0]?.secdef, false, signature);
        assert.deepEqual(r.rows[0]?.cfg, ['search_path=""'], signature);
        for (const role of ['public', 'anon', 'authenticated']) {
          const ok = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, `public.${signature}`]);
          assert.equal(ok.rows[0]?.ok, false, `${role} ${signature}`);
        }
      }
      for (const table of CLUSTER_TABLES) {
        const rls = await db.query<{ rls: boolean }>('SELECT relrowsecurity AS rls FROM pg_class WHERE oid = $1::regclass', [`public.${table}`]);
        assert.equal(rls.rows[0]?.rls, true, table);
        assert.equal(await count(db, 'pg_policies', 'tablename = $1', [table]).catch(async () => 0), 0, `${table}: no policy`);
        for (const role of ['anon', 'authenticated']) {
          const ok = await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, `public.${table}`]);
          assert.equal(ok.rows[0]?.ok, false, `${role} SELECT ${table}`);
        }
      }
    });

    test('defaults: without a state row, and with cluster_status NULL, no cluster row, marker or ledger row is written', async () => {
      const docId = await createDocument(db, FIXTURE_USER_ID);
      const [a, b, c] = await insertChunks(db, docId, [{ text: words(1, 5) }, { text: words(1, 5) }, { text: words(2, 4) }]);
      const cluster = await newCluster(db, tenantA);
      await setCluster(db, [a!, b!], cluster);
      await db.query('UPDATE public.document_chunks SET lexical_text = $2 WHERE id = $1', [c, words(3, 6)]);
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [b]);
      for (const table of STATS_TABLES) assert.equal(await count(db, table), 0, `no state row: ${table}`);

      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      const [d] = await insertChunks(db, docId, [{ text: words(4, 5), cluster }]);
      await setCluster(db, [d!], null);
      await setCluster(db, [d!], cluster);
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [a]);
      await db.query('DELETE FROM public.rag_dup_clusters WHERE id = $1', [cluster]);
      assert.equal(await count(db, 'rag_lexical_stats_pending', "corpus = 'chunks_cluster'"), 0);
      for (const table of CLUSTER_TABLES) assert.equal(await count(db, table), 0, `cluster_status NULL: ${table}`);
      const status = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_status($1)', [tenantA]);
      assert.equal('cluster_status' in status, false);
      const c2 = await check(db, tenantA);
      assert.equal('cluster_df_diff' in c2, false);
    });

    test("the 'chunks' pending rows equal those of the 0901 triggers for the same statements, with or without cluster statistics", async () => {
      const scenario = async (): Promise<Row[]> => {
        await reset(db);
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
        if (withCluster) await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantA]);
        const docId = await createDocument(db, FIXTURE_USER_ID);
        const ids = await insertChunks(db, docId, [
          { text: words(1, 5) },
          { text: words(1, 5) },
          { text: words(2, 4), language: null },
          { text: words(3, 6), status: 'quarantined' },
          { text: words(5, 3), profile: 'probe-profile' },
        ]);
        const cluster = await newCluster(db, tenantA);
        await setCluster(db, [ids[0]!, ids[1]!], cluster);
        await db.query("UPDATE public.document_chunks SET lexical_text = $2, status = 'variant' WHERE id = $1", [ids[2], words(7, 5)]);
        await db.query("UPDATE public.document_chunks SET status = 'ready' WHERE id = $1", [ids[3]]);
        await db.query('UPDATE public.document_chunks SET is_current = false WHERE id = $1', [ids[4]]);
        await db.query('DELETE FROM public.rag_dup_clusters WHERE id = $1', [cluster]);
        await db.query('DELETE FROM public.document_chunks WHERE id = $1', [ids[1]]);
        // Rows are staged in chunk-id order and the ids are random, so the comparison is on the sorted rows.
        return sorted(
          (
            await db.query<Row>(
              `SELECT tenant_key, corpus, chunking_profile_id, language, sign::int AS sign, lexemes, dl FROM public.rag_lexical_stats_pending
                WHERE corpus = 'chunks' ORDER BY id`,
            )
          ).rows,
        );
      };
      let withCluster = false;
      const newRaw = await scenario();
      withCluster = true;
      const newCluster_ = await scenario();
      await db.exec(fs.readFileSync(MIGRATION_0901, 'utf8'));
      try {
        withCluster = false;
        const oldRaw = await scenario();
        assert.ok(oldRaw.length > 0);
        assert.deepEqual(newRaw, oldRaw);
        assert.deepEqual(newCluster_, oldRaw);
      } finally {
        await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      }
    });

    test('enable and rebuild on a tenant without clusters: chunks_cluster counters equal chunks counters row for row; ledger empty', async () => {
      const docId = await createDocument(db, FIXTURE_USER_ID);
      await insertChunks(
        db,
        docId,
        Array.from({ length: 40 }, (_, i) => ({ text: words(i, 3 + (i % 6)), language: i % 5 === 0 ? null : 'en', profile: i % 4 === 0 ? 'probe-profile' : 'legacy' })),
      );
      await enableCluster(db, tenantA);
      assert.deepEqual(await counters(db, tenantA, 'chunks_cluster'), await counters(db, tenantA, 'chunks'));
      assert.equal(await count(db, 'rag_lexical_cluster_units'), 0);
      const status = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_status($1)', [tenantA]);
      assert.equal(status.cluster_status, 'ready');
      assert.equal(Number(status.cluster_dirty), 0);
      assertClusterClean(await check(db, tenantA), 'no clusters');
    });

    test('one passage copied into 30 documents and clustered with rag_dup_assign: df 30 under chunks, df 1 under chunks_cluster', async () => {
      await enableCluster(db, tenantA);
      const passage = 'w31 w32 w33 w34 w35 w36';
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const docId = await createDocument(db, FIXTURE_USER_ID);
        ids.push(...(await insertChunks(db, docId, [{ text: passage }, { text: words(100 + i, 4) }])).slice(0, 1));
      }
      const assigned = await rpc<string>(db, '(public.rag_dup_assign($1, $2::uuid[], NULL)).cluster_id', [tenantA, ids]);
      assert.match(assigned, /^[0-9a-f-]{36}$/);
      assert.equal(await count(db, 'document_chunks', 'id = ANY ($1::uuid[]) AND dup_cluster_id IS NOT NULL', [ids]), 30);
      await assertSettled(db, tenantA, '30 copies');

      for (const lexeme of lexemes(passage)) {
        const raw = await db.query<{ df: number }>("SELECT df::int AS df FROM public.rag_lexical_df WHERE tenant_key = $1 AND corpus = 'chunks' AND lexeme = $2", [tenantA, lexeme]);
        const cl = await db.query<{ df: number }>("SELECT df::int AS df FROM public.rag_lexical_df WHERE tenant_key = $1 AND corpus = 'chunks_cluster' AND lexeme = $2", [
          tenantA,
          lexeme,
        ]);
        assert.equal(raw.rows[0]?.df, 30, `${lexeme} raw`);
        assert.equal(cl.rows[0]?.df, 1, `${lexeme} cluster`);
      }
      const raw = await counters(db, tenantA, 'chunks');
      const cl = await counters(db, tenantA, 'chunks_cluster');
      assert.equal(Number(raw.corpus[0]!.chunk_count) - Number(cl.corpus[0]!.chunk_count), 29);
      const units = await ledger(db, tenantA);
      assert.equal(units.length, 1);
      assert.equal(units[0]!.chunk_id, [...ids].sort()[0]);

      // The same corpus rebuilt from scratch gives the same counters and ledger.
      const before_ = JSON.stringify([await counters(db, tenantA, 'chunks_cluster'), units]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assert.equal(JSON.stringify([await counters(db, tenantA, 'chunks_cluster'), await ledger(db, tenantA)]), before_);
    });

    test('staging: each old/new state pair stages exactly the rows of the D-47 table', async () => {
      await enableCluster(db, tenantA);
      await markSeen(db);
      const docId = await createDocument(db, FIXTURE_USER_ID);
      const A = await newCluster(db, tenantA);
      const B = await newCluster(db, tenantA);
      const t = (seed: number) => words(seed, 4);
      const [loose, joined, inA, inA2, outsider] = await insertChunks(db, docId, [
        { text: t(1) },
        { text: t(2) },
        { text: t(3), cluster: A },
        { text: t(4), cluster: A },
        { text: t(5), status: 'quarantined', cluster: A },
      ]);
      const plus = (seed: number) => ({ tenant_key: tenantA, chunking_profile_id: 'legacy', language: 'en', sign: 1, lexemes: lexemes(t(seed)), dl: 4 });
      const minus = (seed: number) => ({ ...plus(seed), sign: -1 });
      const mark = (id: string) => ({ tenant_key: tenantA, dup_cluster_id: id });
      const staged = async () => {
        const out = await stagedCluster(db);
        return {
          pending: sorted(out.pending.map((r) => ({ ...r, lexemes: [...(r.lexemes as string[])].sort() }))),
          markers: sorted(out.markers),
        };
      };
      const want = (pending: Row[], markers: Row[]) => ({ pending: sorted(pending), markers: sorted(markers) });
      assert.deepEqual(await staged(), want([plus(1), plus(2)], [mark(A)]), 'insert: +1 per loose member, one marker per cluster');

      await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE id = $1", [loose]);
      assert.deepEqual(await staged(), want([minus(1)], []), 'member, no cluster -> not member');
      await db.query("UPDATE public.document_chunks SET status = 'ready' WHERE id = $1", [loose]);
      assert.deepEqual(await staged(), want([plus(1)], []), 'not member -> member, no cluster');
      await db.query("UPDATE public.document_chunks SET chunking_profile_id = 'probe-profile' WHERE id = $1", [loose]);
      assert.deepEqual(await staged(), want([minus(1), { ...plus(1), chunking_profile_id: 'probe-profile' }], []), 'profile change');
      await db.query("UPDATE public.document_chunks SET chunking_profile_id = 'legacy' WHERE id = $1", [loose]);
      await markSeen(db);
      await db.query('UPDATE public.document_chunks SET lexical_text = $2 WHERE id = $1', [inA, t(6)]);
      assert.deepEqual(await staged(), want([], [mark(A)]), 'member in A, vector changed');
      await setCluster(db, [joined!], B);
      assert.deepEqual(await staged(), want([minus(2)], [mark(B)]), 'dup_cluster_id-only update: member, no cluster -> member in B');
      await setCluster(db, [joined!], A);
      assert.deepEqual(await staged(), want([], [mark(A), mark(B)]), 'B -> A marks both');
      await setCluster(db, [joined!], null);
      assert.deepEqual(await staged(), want([plus(2)], [mark(A)]), 'member in A -> member, no cluster');
      await db.query("UPDATE public.document_chunks SET content = 'neutral other' WHERE id = $1", [inA2]);
      assert.deepEqual(await staged(), want([], []), 'no relevant change');
      await db.query('UPDATE public.document_chunks SET lexical_text = $2 WHERE id = $1', [outsider, t(7)]);
      assert.deepEqual(await staged(), want([], []), 'not member -> not member');
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [inA2]);
      assert.deepEqual(await staged(), want([], [mark(A)]), 'delete of a clustered member');
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [joined]);
      assert.deepEqual(await staged(), want([minus(2)], []), 'delete of a loose member');
      await db.query('DELETE FROM public.rag_dup_clusters WHERE id = $1', [A]);
      const dissolved = await staged();
      assert.deepEqual(dissolved.markers, [mark(A)], 'ON DELETE SET NULL marks the dissolved cluster');
      assert.deepEqual(dissolved.pending, [{ ...plus(6) }], 'and stages +1 for its member that became loose');
      await assertSettled(db, tenantA, 'after the staging sequence');
    });

    test('the unit moves to the next smallest member id; deleting the last member removes the ledger row and its counters', async () => {
      await enableCluster(db, tenantA);
      const cluster = await newCluster(db, tenantA);
      const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort();
      const docId = await createDocument(db, FIXTURE_USER_ID);
      await insertChunks(db, docId, [{ text: 'w1 w2 w3', cluster }, { text: 'w1 w2 w4', cluster }, { text: 'w1 w5', cluster }], ids);
      await assertSettled(db, tenantA, 'three copies');
      assert.equal((await ledger(db, tenantA))[0]!.chunk_id, ids[0]);
      await db.query('DELETE FROM public.document_chunks WHERE id = $1', [ids[0]]);
      await assertSettled(db, tenantA, 'unit deleted');
      const moved = await ledger(db, tenantA);
      assert.equal(moved[0]!.chunk_id, ids[1]);
      assert.deepEqual(moved[0]!.lexemes, ['w1', 'w2', 'w4']);
      await db.query('DELETE FROM public.document_chunks WHERE id = ANY ($1::uuid[])', [ids.slice(1)]);
      await assertSettled(db, tenantA, 'last member deleted');
      assert.equal((await ledger(db, tenantA)).length, 0);
      assert.deepEqual(await counters(db, tenantA, 'chunks_cluster'), { df: [], corpus: [] });
    });

    test('a cluster with copies in two chunking profiles and two languages has one unit per key', async () => {
      await enableCluster(db, tenantA);
      const cluster = await newCluster(db, tenantA);
      const docId = await createDocument(db, FIXTURE_USER_ID);
      await insertChunks(db, docId, [
        { text: 'w1 w2', cluster },
        { text: 'w1 w2', cluster },
        { text: 'w1 w2', cluster, profile: 'probe-profile' },
        { text: 'w1 w2', cluster, language: 'it' },
        { text: 'w1 w2', cluster, language: null },
      ]);
      await assertSettled(db, tenantA, 'profiles and languages');
      const units = await ledger(db, tenantA);
      assert.deepEqual(
        units.map((u) => `${u.chunking_profile_id}|${u.language}`).sort(),
        ['legacy|en', 'legacy|it', 'legacy|und', 'probe-profile|en'],
      );
    });

    test('supersession, quarantine and relex of clustered chunks keep both corpora drift-free after compaction', async () => {
      await enableCluster(db, tenantA);
      const cluster = await newCluster(db, tenantA);
      const docId = await createDocument(db, FIXTURE_USER_ID);
      const ids = await insertChunks(db, docId, Array.from({ length: 6 }, (_, i) => ({ text: words(i % 2, 5), cluster: i < 4 ? cluster : null })));
      await assertSettled(db, tenantA, 'seeded');
      await db.query('UPDATE public.document_chunks SET is_current = false WHERE id = ANY ($1::uuid[])', [ids.slice(0, 2)]);
      await assertSettled(db, tenantA, 'superseded');
      await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE id = $1", [ids[2]]);
      await assertSettled(db, tenantA, 'quarantined');
      await db.query('UPDATE public.document_chunks SET lexical_text = $2 WHERE id = ANY ($1::uuid[])', [[ids[3], ids[4]], words(9, 7)]);
      await assertSettled(db, tenantA, 'relexed');
      const raw = await check(db, tenantA);
      assert.equal(raw.clean, true);
    });

    test('the drift check is exact mid-backlog and after compaction, and reports a corrupted counter or ledger row', async () => {
      await enableCluster(db, tenantA);
      const cluster = await newCluster(db, tenantA);
      const docId = await createDocument(db, FIXTURE_USER_ID);
      const ids = await insertChunks(db, docId, [{ text: 'w1 w2 w3', cluster }, { text: 'w1 w2 w3', cluster }, { text: 'w7 w8' }]);
      const mid = await check(db, tenantA);
      assert.ok(Number(mid.cluster_dirty) > 0, 'markers present');
      assertClusterClean(mid, 'mid-backlog');
      const status = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_status($1)', [tenantA]);
      assert.equal(status.cluster_status, 'ready');
      assert.equal(Number(status.cluster_dirty), 1);
      assert.ok(status.cluster_oldest_dirty_at, 'oldest marker timestamp');
      assert.equal(typeof status.cluster_oldest_dirty_age_s, 'number');
      await setCluster(db, [ids[2]!], cluster);
      assertClusterClean(await check(db, tenantA), 'mid-backlog after a join');
      await assertSettled(db, tenantA, 'compacted');

      const target = (
        await db.query<{ lexeme: string }>("SELECT min(lexeme) AS lexeme FROM public.rag_lexical_df WHERE tenant_key = $1 AND corpus = 'chunks_cluster'", [tenantA])
      ).rows[0]!.lexeme;
      await db.query("UPDATE public.rag_lexical_df SET df = df + 1 WHERE tenant_key = $1 AND corpus = 'chunks_cluster' AND lexeme = $2", [tenantA, target]);
      const corrupt = await check(db, tenantA);
      assert.ok(Number(corrupt.cluster_df_diff) > 0);
      assert.equal(corrupt.clean, false);
      await db.query("UPDATE public.rag_lexical_df SET df = df - 1 WHERE tenant_key = $1 AND corpus = 'chunks_cluster' AND lexeme = $2", [tenantA, target]);
      await db.query('UPDATE public.rag_lexical_cluster_units SET chunk_id = $2 WHERE tenant_key = $1', [tenantA, crypto.randomUUID()]);
      const ledgerCorrupt = await check(db, tenantA);
      assert.ok(Number(ledgerCorrupt.cluster_ledger_diff) > 0);
      assert.equal(ledgerCorrupt.clean, false);
      for (const key of Object.keys(ledgerCorrupt)) assert.doesNotMatch(JSON.stringify(ledgerCorrupt[key as keyof Check]), /w[0-9]/, key);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assertClusterClean(await check(db, tenantA), 'after repair');
    });

    test('cluster_disable removes every cluster row and leaves corpus chunks untouched; disable removes everything', async () => {
      const cluster = await newCluster(db, tenantA);
      const docId = await createDocument(db, FIXTURE_USER_ID);
      await insertChunks(db, docId, [{ text: 'w1 w2', cluster }, { text: 'w1 w2', cluster }, { text: 'w3' }]);
      await enableCluster(db, tenantA);
      await insertChunks(db, docId, [{ text: 'w4 w5', cluster }, { text: 'w6' }]);
      const raw = JSON.stringify([
        await counters(db, tenantA, 'chunks'),
        (await db.query("SELECT * FROM public.rag_lexical_stats_pending WHERE corpus = 'chunks' ORDER BY id")).rows,
      ]);
      assert.equal(await rpc(db, 'public.rag_lexstats_cluster_disable($1)', [tenantA]), true);
      assert.equal(
        JSON.stringify([await counters(db, tenantA, 'chunks'), (await db.query("SELECT * FROM public.rag_lexical_stats_pending WHERE corpus = 'chunks' ORDER BY id")).rows]),
        raw,
      );
      for (const table of ['rag_lexical_df', 'rag_lexical_corpus', 'rag_lexical_stats_pending']) assert.equal(await count(db, table, "corpus = 'chunks_cluster'"), 0, table);
      for (const table of CLUSTER_TABLES) assert.equal(await count(db, table), 0, table);
      const state = await db.query<{ cluster_status: string | null; cluster_rebuilt_at: string | null }>(
        'SELECT cluster_status, cluster_rebuilt_at FROM public.rag_lexical_stats_state WHERE tenant_key = $1',
        [tenantA],
      );
      assert.deepEqual(state.rows[0], { cluster_status: null, cluster_rebuilt_at: null });
      assert.equal(await rpc(db, 'public.rag_lexstats_cluster_disable($1)', [tenantA]), false);

      await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantA]);
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      await insertChunks(db, docId, [{ text: 'w9', cluster }]);
      assert.ok((await count(db, 'rag_lexical_cluster_units')) > 0);
      assert.equal(await rpc(db, 'public.rag_lexstats_disable($1)', [tenantA]), true);
      for (const table of STATS_TABLES) assert.equal(await count(db, table, 'tenant_key = $1', [tenantA]), 0, table);
    });

    test('cluster_enable needs the state row (55000), is idempotent and never resets ready; the other mode key is rejected', async () => {
      const err = await sqlError(rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantA]));
      assert.equal(err.code, '55000');
      assert.match(err.message ?? '', /lexical_stats_not_enabled/);
      await rpc(db, 'public.rag_lexstats_enable($1)', [tenantA]);
      assert.equal(await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantA]), 'building');
      assert.equal(await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantA]), 'building');
      await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenantA]);
      assert.equal(await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenantA]), 'ready');
      for (const fn of ['rag_lexstats_cluster_enable', 'rag_lexstats_cluster_disable', 'rag_lexstats_check']) {
        for (const key of [otherModeKey, 'not-a-key']) {
          const e = await sqlError(rpc(db, `public.${fn}($1)`, [key]));
          assert.equal(e.code, '22023', `${fn}(${key})`);
        }
      }
    });

    test('purge: the dup-cluster hook, then the chunk delete, then the lexical hook leave no ledger row for a deleted chunk and no marker', async () => {
      await enableCluster(db, tenantA);
      const cluster = await newCluster(db, tenantA);
      const doomed = await createDocument(db, FIXTURE_USER_ID);
      const kept = await createDocument(db, FIXTURE_USER_ID);
      await insertChunks(db, doomed, [{ text: 'w1 w2 w3', cluster }, { text: 'w4', cluster: null }]);
      await insertChunks(db, kept, [{ text: 'w1 w2 w3', cluster }]);
      await assertSettled(db, tenantA, 'seeded');
      await rpc(db, 'public.rag_purge_hook_dup_clusters($1, NULL::uuid, $2::uuid[])', [tenantA, [doomed]]);
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [doomed]);
      await rpc(db, 'public.rag_purge_hook_lexical_stats($1, NULL::uuid, $2::uuid[])', [tenantA, [doomed]]);
      assert.equal(await count(db, 'rag_lexical_cluster_units u', 'NOT EXISTS (SELECT 1 FROM public.document_chunks c WHERE c.id = u.chunk_id)'), 0);
      assert.equal(await count(db, 'rag_lexical_cluster_dirty'), 0);
      await assertSettled(db, tenantA, 'after purge');

      // A ledger row orphaned without any marker (for example a chunk removed while triggers were disabled) is marked by the hook.
      await db.exec('ALTER TABLE public.document_chunks DISABLE TRIGGER rag_lexstats_chunks_delete');
      try {
        await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [kept]);
      } finally {
        await db.exec('ALTER TABLE public.document_chunks ENABLE TRIGGER rag_lexstats_chunks_delete');
      }
      assert.equal(await count(db, 'rag_lexical_cluster_units'), 1);
      await rpc(db, 'public.rag_purge_hook_lexical_stats($1, NULL::uuid, ARRAY[]::uuid[])', [tenantA]);
      assert.equal(await count(db, 'rag_lexical_cluster_units'), 0);
      assert.equal(await count(db, 'rag_lexical_cluster_dirty'), 0);
    });

    test('purge: rag_purge_lineage folds the lexical statistics after its chunk delete and rag_purge_verify reports lexical_stats', async (t) => {
      // 04.4-07 hand-off, migration 0746: the Phase 6.3 purge runs rag_purge_hook_lexical_stats after the chunk delete, so the -1 rows
      // the delete triggers stage are folded and no ledger row keeps a purged chunk's lexemes.
      const present = await db.query<{ ok: boolean }>("SELECT to_regprocedure('public.rag_purge_lineage(text,uuid,jsonb,jsonb)') IS NOT NULL AS ok");
      if (!present.rows[0]!.ok) {
        t.skip('Phase 6.3 purge (0727) not on this checkout');
        return;
      }
      await enableCluster(db, tenantA);
      const cluster = await newCluster(db, tenantA);
      const doomed = await createDocument(db, FIXTURE_USER_ID);
      const kept = await createDocument(db, FIXTURE_USER_ID);
      const [doomedUnit] = await insertChunks(db, doomed, [{ text: 'w1 w2 w3', cluster }, { text: 'w4', cluster: null }]);
      await insertChunks(db, kept, [{ text: 'w1 w2 w3', cluster }]);
      await assertSettled(db, tenantA, 'seeded');
      const lineage = (await db.query<{ lineage_id: string }>('SELECT lineage_id FROM public.documents WHERE id = $1', [doomed])).rows[0]!.lineage_id;

      await db.query('INSERT INTO public.admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [FIXTURE_USER_ID]);
      let counts: Record<string, unknown>;
      try {
        const r = await db.query<{ counts: Record<string, unknown> }>(
          'SELECT counts FROM public.rag_purge_lineage($1, $2, $3::jsonb, $4::jsonb)',
          [tenantA, lineage, JSON.stringify({ kind: 'admin', id: FIXTURE_USER_ID }), JSON.stringify({ code: 'added_in_error', note: 'synthetic test purge' })],
        );
        counts = r.rows[0]!.counts;
      } finally {
        await db.query('DELETE FROM public.admin_users WHERE id = $1', [FIXTURE_USER_ID]);
      }
      assert.ok(Number(counts.lexical_stats) > 0, `the purge counts the folded lexical rows: ${JSON.stringify(counts)}`);
      assert.equal(await count(db, 'rag_lexical_stats_pending', 'tenant_key = $1', [tenantA]), 0, 'no staged removal is left');
      assert.equal(await count(db, 'rag_lexical_cluster_dirty', 'tenant_key = $1', [tenantA]), 0, 'no marker is left');
      assert.equal(await count(db, 'rag_lexical_cluster_units', 'chunk_id = $1', [doomedUnit]), 0, 'no ledger row keeps the purged chunk');
      await assertSettled(db, tenantA, 'after rag_purge_lineage');

      const verify = async () =>
        (await db.query<{ store: string; remaining: string }>('SELECT store, remaining FROM public.rag_purge_verify($1, $2)', [tenantA, lineage])).rows.find(
          (row) => row.store === 'lexical_stats',
        );
      assert.equal(Number((await verify())?.remaining), 0, 'verify lists lexical_stats with nothing remaining');
      await db.query('INSERT INTO public.rag_lexical_cluster_dirty (tenant_key, dup_cluster_id) VALUES ($1, $2)', [tenantA, cluster]);
      assert.equal(Number((await verify())?.remaining), 1, 'an unreconciled marker is reported');
      await compactUntilZero(db, tenantA);
      assert.equal(Number((await verify())?.remaining), 0);
    });

    test('the Phase 6.3 store inventory lists the six lexical statistics relations under lexical_stats', async (t) => {
      const present = await db.query<{ ok: boolean }>("SELECT to_regprocedure('public.rag_purge_store_inventory()') IS NOT NULL AS ok");
      if (!present.rows[0]!.ok) {
        t.skip('Phase 6.3 store inventory (0728) not on this checkout');
        return;
      }
      const rows = (
        await db.query<{ relation: string; store_id: string; handling: string }>(
          "SELECT relation, store_id, handling FROM public.rag_purge_store_inventory() WHERE relation LIKE 'rag\\_lexical\\_%' ORDER BY relation",
        )
      ).rows.map((row) => `${row.relation} ${row.store_id} ${row.handling}`);
      assert.deepEqual(rows, [
        'rag_lexical_cluster_dirty lexical_stats purge_step',
        'rag_lexical_cluster_units lexical_stats purge_step',
        'rag_lexical_corpus lexical_stats purge_step',
        'rag_lexical_df lexical_stats purge_step',
        'rag_lexical_stats_pending lexical_stats purge_step',
        'rag_lexical_stats_state  exempt',
      ]);
    });

    if (tenantB) {
      test('two tenants: clustering, editing and deleting chunks of tenant A changes no counter, ledger row, marker or pending row of B', async () => {
        const snapshotB = async () => {
          const parts: unknown[] = [];
          for (const table of STATS_TABLES) {
            const cols = table === 'rag_lexical_stats_pending' ? 'corpus, chunking_profile_id, language, sign, lexemes, dl' : table === 'rag_lexical_cluster_dirty' ? 'dup_cluster_id' : '*';
            parts.push(sorted((await db.query<Row>(`SELECT ${cols} FROM public.${table} WHERE tenant_key = $1`, [tenantB])).rows));
          }
          return JSON.stringify(parts);
        };
        const docB = await createDocument(db, SECOND_USER_ID);
        const clusterB = await newCluster(db, tenantB);
        await insertChunks(db, docB, [{ text: 'w1 w2 w3', cluster: clusterB }, { text: 'w1 w2 w3', cluster: clusterB }, { text: 'w1 w9' }]);
        await enableCluster(db, tenantB);
        await enableCluster(db, tenantA);
        const beforeB = await snapshotB();

        const docA = await createDocument(db, FIXTURE_USER_ID);
        const clusterA = await newCluster(db, tenantA);
        const ids = await insertChunks(db, docA, [{ text: 'w1 w2 w3' }, { text: 'w1 w2 w3' }, { text: 'w1 w5' }]);
        await setCluster(db, ids.slice(0, 2), clusterA);
        await db.query('UPDATE public.document_chunks SET lexical_text = $2 WHERE id = $1', [ids[2], 'w1 w2 w6']);
        await compactUntilZero(db, tenantA);
        await db.query('DELETE FROM public.document_chunks WHERE id = $1', [ids[0]]);
        await db.query('DELETE FROM public.rag_dup_clusters WHERE id = $1', [clusterA]);
        await assertSettled(db, tenantA, 'tenant A');
        await rpc(db, 'public.rag_lexstats_cluster_disable($1)', [tenantA]);
        assert.equal(await snapshotB(), beforeB);
        assertClusterClean(await check(db, tenantB), 'tenant B');
        const unitsB = await ledger(db, tenantB);
        assert.equal(unitsB.length, 1);
      });
    }
  });
}
