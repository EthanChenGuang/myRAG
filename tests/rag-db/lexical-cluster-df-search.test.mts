import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { bm25ClusterReference, bm25Reference } from '../helpers/bm25-reference.ts';

/**
 * 0938 (plan 04.4-17, D-49): rag_bm25_search_chunks gains p_df_mode text DEFAULT 'raw', rebuilt on the 0936 body. With raw (or omitted)
 * every result equals the 0936 function's, captured in the same database before the file is applied. With cluster the statistics are
 * read from corpus chunks_cluster (0905, D-46) and the scores equal the TypeScript unit reference; a tenant whose cluster statistics are
 * not ready gets lexical_cluster_stats_not_ready (55000). Tokens are neutral generated words (D-41).
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0938_bm25_search_df_mode.sql';
const LEGACY = 'openai-3-small-1536';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SECOND_USER_ID = '00000000-0000-4000-8000-0000000938b2';
const GROUP = 'g:00000000-0000-4000-8000-000000093801';
const PASSAGE = ['w9101', 'w9102', 'w9103', 'w9104', 'w9105'];
const COMMON = ['w9201', 'w9202'];
const QUERY = ['w9101', ...COMMON];
const BM25_ARGS_0936 = [
  'p_tenant_key', 'p_profile_id', 'p_query_embedding', 'p_lexical_tokens', 'p_lexical_limit', 'p_date_from', 'p_date_to', 'p_sources',
  'p_document_ids', 'p_doc_types', 'p_languages', 'p_lexical_languages', 'p_supplier', 'p_amount_min', 'p_amount_max', 'p_currency',
  'p_chunking_override', 'p_include_undated', 'p_scopes', 'p_scopes_include_untagged', 'p_effective_on', 'p_version_scope',
  'p_identifiers_norm', 'p_k1', 'p_b', 'p_candidate_limit', 'p_access_keys', 'p_access_all',
];

type Row = Record<string, unknown>;

interface Seeded {
  id: string;
  tenant: string;
  tokens: string[];
  cluster: string | null;
}

interface Call {
  name: string;
  tokens: string[];
  args?: Record<string, unknown>;
}

const CASTS: Record<string, string> = {
  p_doc_types: 'text[]',
  p_lexical_languages: 'text[]',
  p_version_scope: 'jsonb',
  p_identifiers_norm: 'text[]',
  p_access_keys: 'text[]',
  p_access_all: 'boolean',
  p_candidate_limit: 'integer',
  p_k1: 'double precision',
  p_b: 'double precision',
  p_df_mode: 'text',
};

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function insertDocument(
  db: PGlite,
  userId: string,
  chunks: Array<{ tokens: string[]; cluster?: string | null; identifiers?: string[] }>,
  doc: { docType?: string; language?: string; accessGroups?: string[] } = {},
): Promise<string[]> {
  const docId = crypto.randomUUID();
  await db.query(
    `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, language, is_current, status, access_groups)
     VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, $4, $5, true, 'ready', $6::text[])`,
    [docId, `dfmode-${docId.slice(0, 8)}.txt`, userId, doc.docType ?? 'general', doc.language ?? 'en', doc.accessGroups ?? ['all']],
  );
  const ids = chunks.map(() => crypto.randomUUID());
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, chunk_kind,
       chunking_profile_id, status, is_current, dup_cluster_id, identifiers_norm)
     SELECT u.id, $1::uuid, u.txt, '{}'::jsonb, u.ord::int - 1, u.txt, $2, $3, 'text', 'legacy', 'ready', true, u.cluster,
            CASE WHEN u.ids = '' THEN NULL ELSE string_to_array(u.ids, ',') END
       FROM unnest($4::uuid[], $5::text[], $6::uuid[], $7::text[]) WITH ORDINALITY AS u(id, txt, cluster, ids, ord)`,
    [
      docId,
      doc.language ?? 'en',
      doc.docType ?? 'general',
      ids,
      chunks.map((c) => c.tokens.join(' ')),
      chunks.map((c) => c.cluster ?? null),
      chunks.map((c) => (c.identifiers ?? []).join(',')),
    ],
  );
  return ids;
}

async function newCluster(db: PGlite, tenantKey: string): Promise<string> {
  return (
    await db.query<{ id: string }>('INSERT INTO public.rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, $2) RETURNING id', [
      tenantKey,
      LEGACY,
    ])
  ).rows[0]!.id;
}

async function rpc<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return (await db.query<{ v: T }>(`SELECT ${sql} AS v`, params)).rows[0]!.v;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function compactUntilZero(db: PGlite, tenantKey: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (Number(await rpc<number>(db, 'public.rag_lexstats_compact($1, $2)', [tenantKey, 5000])) === 0) return;
  }
  throw new Error('compaction did not converge');
}

async function search(db: PGlite, tenant: string, call: Call, dfMode?: string): Promise<Row[]> {
  const args = { ...(call.args ?? {}), ...(dfMode === undefined ? {} : { p_df_mode: dfMode }) };
  const params: unknown[] = [tenant, LEGACY, call.tokens];
  const parts: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    params.push(typeof value === 'object' && value !== null && !Array.isArray(value) ? JSON.stringify(value) : value);
    parts.push(`, ${name} => $${params.length}::${CASTS[name] ?? assert.fail(`cast for ${name}`)}`);
  }
  return (
    await db.query<Row>(
      `SELECT rank, chunk_id::text AS chunk_id, lexical_score FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2,
         p_query_embedding => NULL, p_lexical_tokens => $3::text[], p_lexical_limit => 200${parts.join('')}) ORDER BY rank`,
      params,
    )
  ).rows;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

async function bm25Catalog(db: PGlite): Promise<Row[]> {
  return (
    await db.query<Row>(
      `SELECT pg_get_function_arguments(p.oid) AS args, p.prosecdef AS definer, p.proconfig AS config, md5(p.prosrc) AS src
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_bm25_search_chunks'`,
    )
  ).rows;
}

function ranked(chunks: Seeded[], scores: number[]): Array<{ id: string; score: number }> {
  return chunks
    .map((c, i) => ({ id: c.id, score: scores[i] as number }))
    .filter((x) => x.score > 0)
    .sort((x, y) => (Math.abs(y.score - x.score) > 1e-9 ? y.score - x.score : x.id < y.id ? -1 : 1));
}

function assertScores(rows: Row[], expected: Array<{ id: string; score: number }>, label: string): void {
  assert.equal(rows.length, expected.length, `${label}: row count`);
  const byId = new Map(expected.map((e) => [e.id, e.score]));
  rows.forEach((row, i) => {
    const ref = byId.get(String(row.chunk_id));
    assert.ok(ref !== undefined, `${label}: unexpected chunk at rank ${i + 1}`);
    const target = (expected[i] as { score: number }).score;
    assert.ok(Math.abs(ref - target) <= 1e-9 * Math.max(1, target), `${label}: order at rank ${i + 1}`);
    assert.ok(Math.abs(Number(row.lexical_score) - ref) <= 1e-6 * Math.max(1, ref), `${label}: score ${row.lexical_score} vs ${ref}`);
  });
}

for (const mode of MODES) {
  const tenantA = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const tenantB = mode === 'multi-tenant' ? `u:${SECOND_USER_ID}` : null;

  describe(`0938 rag_bm25_search_chunks p_df_mode (${mode})`, () => {
    let db: PGlite;
    const seeded: Seeded[] = [];
    let copies: string[] = [];
    let commons: string[] = [];
    let calls: Call[] = [];
    const before0938: Record<string, Row[]> = {};
    let catalogBefore: Row[] = [];

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false })).db;
      const files = migrationFiles(mode);
      assert.ok(files.includes(MIGRATION), `${MIGRATION} is in the migration list`);
      const split = files.indexOf(MIGRATION);
      await applyMigrationFiles(db, files.slice(0, split));
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
      } else {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'second-user@example.invalid')", [SECOND_USER_ID]);
      }

      const seed = async (tenant: string, userId: string): Promise<{ copies: string[]; commons: string[] }> => {
        const cluster = await newCluster(db, tenant);
        const c: string[] = [];
        const m: string[] = [];
        for (let i = 0; i < 30; i += 1) {
          const [id] = await insertDocument(db, userId, [{ tokens: PASSAGE, cluster }]);
          c.push(id as string);
          seeded.push({ id: id as string, tenant, tokens: PASSAGE, cluster });
        }
        for (let i = 0; i < 20; i += 1) {
          const tokens = [...COMMON, 'w9301', 'w9302', 'w9303'];
          const [id] = await insertDocument(db, userId, [{ tokens }]);
          m.push(id as string);
          seeded.push({ id: id as string, tenant, tokens, cluster: null });
        }
        for (let i = 0; i < 40; i += 1) {
          const tokens = [`w94${String(i).padStart(2, '0')}`, 'w9304', 'w9305', 'w9306', 'w9307'];
          const [id] = await insertDocument(db, userId, [{ tokens }]);
          seeded.push({ id: id as string, tenant, tokens, cluster: null });
        }
        // Filter variety for the raw parity cases: another doc type, an identifier, a restricted document.
        for (const [extra, opts] of [
          [{ tokens: ['w9101', 'w9301', 'w9501'], identifiers: ['zq-9381'] }, {}],
          [{ tokens: ['w9201', 'w9502'] }, { docType: 'contract_legal' }],
          [{ tokens: ['w9202', 'w9503', 'w9504'] }, { accessGroups: [GROUP] }],
        ] as const) {
          const [id] = await insertDocument(db, userId, [{ ...extra, identifiers: 'identifiers' in extra ? [...extra.identifiers] : undefined, tokens: [...extra.tokens] }], opts);
          seeded.push({ id: id as string, tenant, tokens: [...extra.tokens], cluster: null });
        }
        await rpc(db, 'public.rag_lexstats_enable($1)', [tenant]);
        await rpc(db, 'public.rag_lexstats_cluster_enable($1)', [tenant]);
        await rpc(db, 'public.rag_lexstats_rebuild($1)', [tenant]);
        return { copies: c, commons: m };
      };
      ({ copies, commons } = await seed(tenantA, FIXTURE_USER_ID));
      if (tenantB) await seed(tenantB, SECOND_USER_ID);

      calls = [
        { name: 'passage and common terms', tokens: QUERY },
        { name: 'filler term', tokens: ['w9304'] },
        { name: 'doc type', tokens: QUERY, args: { p_doc_types: ['general'] } },
        { name: 'lexical languages', tokens: QUERY, args: { p_lexical_languages: ['en'] } },
        { name: 'version scope all', tokens: QUERY, args: { p_version_scope: { mode: 'all' } } },
        { name: 'identifier', tokens: ['w9301'], args: { p_identifiers_norm: ['zq-9381'] } },
        { name: 'access keys', tokens: QUERY, args: { p_access_keys: ['all'] } },
        { name: 'access keys, group', tokens: QUERY, args: { p_access_keys: ['all', GROUP] } },
        { name: 'access admin', tokens: QUERY, args: { p_access_keys: ['all'], p_access_all: true } },
        { name: 'candidate cap', tokens: QUERY, args: { p_candidate_limit: 5 } },
        { name: 'k1 and b', tokens: QUERY, args: { p_k1: 2.0, p_b: 0.3 } },
      ];
      for (const call of calls) before0938[call.name] = await search(db, tenantA, call);
      catalogBefore = await bm25Catalog(db);
      await applyMigrationFiles(db, files.slice(split));
    });

    after(async () => {
      await db?.close();
    });

    test('one overload: the 0936 arguments, then p_df_mode text DEFAULT raw; invoker, empty search_path, service_role only', async () => {
      const rows = await bm25Catalog(db);
      assert.equal(rows.length, 1);
      const args = String(rows[0]!.args);
      assert.equal(args, `${String(catalogBefore[0]!.args)}, p_df_mode text DEFAULT 'raw'::text`);
      assert.deepEqual(
        args.split(/,\s*(?=p_)/).map((p) => p.split(' ')[0]),
        [...BM25_ARGS_0936, 'p_df_mode'],
      );
      assert.equal(rows[0]!.definer, false);
      assert.ok(((rows[0]!.config as string[] | null) ?? []).some((c) => c === 'search_path=' || c === 'search_path=""'));
      const oid = (await db.query<{ oid: number }>("SELECT oid::int AS oid FROM pg_proc WHERE proname = 'rag_bm25_search_chunks'")).rows[0]!.oid;
      for (const [role, ok] of [['anon', false], ['authenticated', false], ['service_role', true], ['public', false]] as const) {
        if (role === 'public') {
          const acl = (await db.query<{ acl: string | null }>('SELECT proacl::text AS acl FROM pg_proc WHERE oid = $1', [oid])).rows[0]?.acl ?? '';
          assert.ok(!/(^|[{,])=X/.test(acl), 'no PUBLIC execute');
          continue;
        }
        const got = (await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok", [role, oid])).rows[0]?.ok;
        assert.equal(got, ok, `${role} execute`);
      }
      const src = (await db.query<{ s: string }>("SELECT prosrc AS s FROM pg_proc WHERE proname = 'rag_bm25_search_chunks'")).rows[0]!.s;
      assert.match(src, /identifier-document-filter:begin \*\/ c\.document_id IN \(SELECT ic\.document_id FROM public\.document_chunks ic/);
      assert.match(src, /access_scope_required/);
      assert.match(src, /access_keys_empty/);
    });

    test('raw: omitted and explicit raw return exactly what the 0936 function returned for every case', async () => {
      for (const call of calls) {
        const want = before0938[call.name] as Row[];
        assert.ok(want.length > 0 || call.name === 'candidate cap', `${call.name}: the case matches something`);
        assert.deepEqual(await search(db, tenantA, call), want, `${call.name}: omitted`);
        assert.deepEqual(await search(db, tenantA, call, 'raw'), want, `${call.name}: raw`);
      }
    });

    test('raw equals the chunk reference and ranks a copy of the passage below the common-term chunks', async () => {
      const members = seeded.filter((s) => s.tenant === tenantA);
      const expected = ranked(members, bm25Reference({ docs: members.map((m) => m.tokens), query: QUERY, k1: 1.2, b: 0.75 }));
      const rows = await search(db, tenantA, { name: 'raw', tokens: QUERY, args: { p_candidate_limit: 0 } }, 'raw');
      assertScores(rows, expected, 'raw');
      const rankOf = new Map(rows.map((r) => [String(r.chunk_id), Number(r.rank)]));
      const worstCopy = Math.max(...copies.map((id) => rankOf.get(id) as number));
      const bestCommon = Math.min(...commons.map((id) => rankOf.get(id) as number));
      assert.ok(worstCopy > bestCommon, 'raw: at least one copy below a common-term chunk');
    });

    test('cluster equals the unit reference and ranks every copy above the common-term chunks', async () => {
      const members = seeded.filter((s) => s.tenant === tenantA);
      for (const [cap, label] of [
        [0, 'no cap'],
        [500, 'default cap'],
      ] as const) {
        const expected = ranked(members, bm25ClusterReference({ docs: members, query: QUERY, k1: 1.2, b: 0.75 }));
        const rows = await search(db, tenantA, { name: 'cluster', tokens: QUERY, args: { p_candidate_limit: cap } }, 'cluster');
        assertScores(rows, expected, `cluster, ${label}`);
        const rankOf = new Map(rows.map((r) => [String(r.chunk_id), Number(r.rank)]));
        const worstCopy = Math.max(...copies.map((id) => rankOf.get(id) as number));
        const bestCommon = Math.min(...commons.map((id) => rankOf.get(id) as number));
        assert.ok(worstCopy < bestCommon, `cluster, ${label}: every copy above every common-term chunk`);
      }
      const k = ranked(members, bm25ClusterReference({ docs: members, query: QUERY, k1: 2.0, b: 0.3 }));
      assertScores(await search(db, tenantA, { name: 'k', tokens: QUERY, args: { p_k1: 2.0, p_b: 0.3 } }, 'cluster'), k, 'cluster, k1 and b');
    });

    test('every filter of the raw cases admits the same chunks in both DF modes', async () => {
      for (const call of calls.filter((c) => c.name !== 'candidate cap')) {
        const ids = (rows: Row[]): string[] => rows.map((r) => String(r.chunk_id)).sort();
        assert.deepEqual(ids(await search(db, tenantA, call, 'cluster')), ids(await search(db, tenantA, call)), call.name);
      }
    });

    test('cluster statistics not ready: NULL or building raises lexical_cluster_stats_not_ready (55000); raw still serves', async () => {
      for (const status of [null, 'building']) {
        await db.query('UPDATE public.rag_lexical_stats_state SET cluster_status = $2 WHERE tenant_key = $1', [tenantA, status]);
        try {
          const error = await errorOf(search(db, tenantA, { name: 'x', tokens: QUERY }, 'cluster'));
          assert.equal(codeOf(error), '55000', String(error));
          assert.match(String((error as Error).message), /^lexical_cluster_stats_not_ready/);
          assert.deepEqual(await search(db, tenantA, calls[0]!), before0938[calls[0]!.name], 'raw unaffected');
        } finally {
          await db.query("UPDATE public.rag_lexical_stats_state SET cluster_status = 'ready' WHERE tenant_key = $1", [tenantA]);
        }
      }
      await db.query("UPDATE public.rag_lexical_stats_state SET status = 'building' WHERE tenant_key = $1", [tenantA]);
      try {
        const error = await errorOf(search(db, tenantA, { name: 'x', tokens: QUERY }, 'cluster'));
        assert.match(String((error as Error).message), /^lexical_stats_not_ready/, 'raw statistics are checked first');
      } finally {
        await db.query("UPDATE public.rag_lexical_stats_state SET status = 'ready' WHERE tenant_key = $1", [tenantA]);
      }
    });

    test('any other p_df_mode raises 22023', async () => {
      for (const value of ['', 'Cluster', 'chunks_cluster', null]) {
        const error = await errorOf(search(db, tenantA, { name: 'x', tokens: QUERY }, value as string));
        assert.equal(codeOf(error), '22023', `${String(value)}: ${String(error)}`);
      }
    });

    test('isolation: the other tenant clustering or deleting its chunks changes no result of this tenant', { skip: tenantB === null }, async () => {
      const b = tenantB as string;
      const baseline = {
        raw: await search(db, tenantA, { name: 'r', tokens: QUERY }, 'raw'),
        cluster: await search(db, tenantA, { name: 'c', tokens: QUERY }, 'cluster'),
      };
      const bIds = seeded.filter((s) => s.tenant === b && s.cluster === null).map((s) => s.id);
      const bCluster = await newCluster(db, b);
      await db.query('UPDATE public.document_chunks SET dup_cluster_id = $2::uuid WHERE id = ANY ($1::uuid[])', [bIds.slice(0, 20), bCluster]);
      await compactUntilZero(db, b);
      assert.deepEqual(await search(db, tenantA, { name: 'r', tokens: QUERY }, 'raw'), baseline.raw);
      assert.deepEqual(await search(db, tenantA, { name: 'c', tokens: QUERY }, 'cluster'), baseline.cluster);
      await db.query('DELETE FROM public.document_chunks WHERE id = ANY ($1::uuid[])', [seeded.filter((s) => s.tenant === b).map((s) => s.id).slice(0, 60)]);
      await compactUntilZero(db, b);
      assert.deepEqual(await search(db, tenantA, { name: 'r', tokens: QUERY }, 'raw'), baseline.raw);
      assert.deepEqual(await search(db, tenantA, { name: 'c', tokens: QUERY }, 'cluster'), baseline.cluster);
      const check = await rpc<Record<string, unknown>>(db, 'public.rag_lexstats_check($1)', [b]);
      assert.equal(Number(check.cluster_df_diff ?? 0), 0);
      const wrong = await errorOf(search(db, mode === 'multi-tenant' ? 's:default' : `u:${SECOND_USER_ID}`, { name: 'x', tokens: QUERY }, 'cluster'));
      assert.ok(wrong, 'a key of the other deployment mode is rejected');
    });

    test('re-runs: 0938 twice changes nothing; 0936 on top stops with 55000; 0932, 0936, 0938 and 0904 onward rebuild one overload', async () => {
      const sql = (name: string): string => fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations', name), 'utf8');
      const catalog = await bm25Catalog(db);
      const results = await search(db, tenantA, calls[0]!, 'cluster');
      await db.exec(sql('0938_bm25_search_df_mode.sql'));
      await db.exec(sql('0938_bm25_search_df_mode.sql'));
      assert.deepEqual(await bm25Catalog(db), catalog);
      assert.deepEqual(await search(db, tenantA, calls[0]!, 'cluster'), results);

      const stopped = await errorOf(db.exec(sql('0936_identifier_document_filter.sql')));
      assert.equal(codeOf(stopped), '55000', String(stopped));
      await db.exec('ROLLBACK').catch(() => undefined);
      assert.deepEqual(await bm25Catalog(db), catalog, 'a stopped 0936 leaves the function as it was');

      for (const sequence of [
        ['0932_access_bm25_search.sql', '0936_identifier_document_filter.sql', '0938_bm25_search_df_mode.sql'],
        ['0904_bm25_search_chunks.sql', '0932_access_bm25_search.sql', '0936_identifier_document_filter.sql', '0938_bm25_search_df_mode.sql'],
      ]) {
        for (const file of sequence) await db.exec(sql(file));
        assert.deepEqual(await bm25Catalog(db), catalog, sequence.join(' -> '));
        assert.deepEqual(await search(db, tenantA, calls[0]!, 'cluster'), results, sequence.join(' -> '));
        assert.deepEqual(await search(db, tenantA, calls[0]!), before0938[calls[0]!.name], sequence.join(' -> '));
      }
    });

    test('precheck: without the 0905 cluster_status column the file stops with 55000 and changes nothing', async () => {
      const catalog = await bm25Catalog(db);
      await db.exec('BEGIN');
      try {
        await db.exec('ALTER TABLE public.rag_lexical_stats_state DROP COLUMN cluster_status CASCADE');
        await db.exec('SAVEPOINT s');
        const body = fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8').replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
        const error = await errorOf(db.exec(body));
        assert.equal(codeOf(error), '55000', String(error));
      } finally {
        await db.exec('ROLLBACK');
      }
      assert.deepEqual(await bm25Catalog(db), catalog);
    });
  });
}
