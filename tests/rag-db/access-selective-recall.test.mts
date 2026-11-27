import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import {
  ACCESS_SELECTIVE_IDS,
  ACCESS_SELECTIVE_ROWS,
  SELECTIVE_PROFILE,
  SELECTIVE_QUERY_TEXT,
  accessSelectiveKeys,
  accessSelectiveTenantKey,
  createAccessSelectiveDatabase,
  exactFilteredRanking,
  type SelectiveFixtureDatabase,
} from '../../eval/harness/selective-filter.mts';

// 04.3-16 (SEC-12, D-13, A-09): a restricted member's dense top-k through the pgvector backend equals the brute-force ranking over the
// rows they can see, below the 1000-row exact cutoff (exact scan) and above it (relaxed iterative scan), with the configured iterative
// scan off and no configured exact cutoff.

const K = 10;

describe('restricted-member dense recall on pgvector (D-13, A-09)', () => {
  let fixture: SelectiveFixtureDatabase;
  let db: PGlite;
  let edge: FakeEdge;
  let backendFor: (version: string | null) => import('@/lib/rag/backend/types').RetrievalBackend;
  let scopeFor: (which: 'small' | 'large') => import('@/lib/rag/tenant/scope').TenantScope;
  let accessModule: typeof import('@/lib/rag/tenant/access');
  let pgvectorVersion: string;

  before(async () => {
    fixture = await createAccessSelectiveDatabase();
    db = fixture.db;
    // Force the HNSW index whenever the function runs an ANN query, as on a large production table.
    await db.exec('SET enable_seqscan = off');
    await db.exec('SET enable_bitmapscan = off');
    pgvectorVersion = (await db.query<{ v: string }>("SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'")).rows[0]!.v;
    edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    Object.assign(process.env, env);
    const client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { createPgvectorBackend } = await import('@/lib/rag/backend/pgvector');
    const { loadRagConfig } = await import('@/lib/rag/config');
    const scopeModule = await import('@/lib/rag/tenant/scope');
    accessModule = await import('@/lib/rag/tenant/access');
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_HNSW_ITERATIVE_SCAN: 'off', RAG_EXACT_SCAN_CUTOFF: '0' });
    backendFor = (version) =>
      createPgvectorBackend({ adminClient: () => client, getConfig: () => config, pgvectorVersion: () => version });
    // One fixture tenant; each member reads it through the keys the resolver would mint for them.
    scopeFor = (which) =>
      scopeModule.withAccess(
        scopeModule.mintScope('personal', ACCESS_SELECTIVE_IDS.owner, null),
        accessModule.mintAccessScope('keys', accessSelectiveKeys(which)),
      );
  });

  after(async () => {
    await db?.exec('RESET enable_seqscan').catch(() => undefined);
    await db?.exec('RESET enable_bitmapscan').catch(() => undefined);
    await edge?.close();
    await db?.close();
  });

  async function search(which: 'small' | 'large', version: string | null = pgvectorVersion) {
    const scope = scopeFor(which);
    return backendFor(version).search({
      scope,
      embeddingProfileId: SELECTIVE_PROFILE,
      denseVector: embedText(SELECTIVE_QUERY_TEXT),
      lexicalTokens: [],
      lexicalLanguages: null,
      filters: { currentOnly: true },
      denseLimit: K,
      lexicalLimit: 0,
      access: accessModule.scopeAccessFilter(scope),
      signal: new AbortController().signal,
    } as import('@/lib/rag/backend/types').BackendSearchRequest);
  }

  async function bruteForce(which: 'small' | 'large'): Promise<string[]> {
    return exactFilteredRanking(db, { tenantKey: accessSelectiveTenantKey(), limit: K, accessKeys: accessSelectiveKeys(which) });
  }

  function recall(exact: string[], got: string[]): number {
    const want = new Set(exact.slice(0, K));
    return got.slice(0, K).filter((id) => want.has(id)).length / K;
  }

  test('the fixture splits the tenant as planned', async () => {
    const counts = await db.query<{ label: string; n: number }>(
      'SELECT access_groups[1] AS label, count(*)::int AS n FROM document_chunks GROUP BY 1 ORDER BY 2',
    );
    assert.deepEqual(
      counts.rows.map((row) => row.n),
      [ACCESS_SELECTIVE_ROWS.small, ACCESS_SELECTIVE_ROWS.large, ACCESS_SELECTIVE_ROWS.other],
    );
    assert.ok(ACCESS_SELECTIVE_ROWS.small < 1000 && ACCESS_SELECTIVE_ROWS.large > 1000);
  });

  test('negative control: the configured scan alone (ANN, iterative off) under-fills the small member', async () => {
    const keys = accessSelectiveKeys('small');
    const rows = await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE service_role');
      return (
        await tx.query<{ chunk_id: string }>(
          `SELECT chunk_id::text FROM hybrid_search_chunks(
             p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => '{}'::text[],
             p_dense_limit => $4, p_lexical_limit => 0, p_iterative_scan => 'off', p_exact_scan_cutoff => 0,
             p_access_keys => $5::text[], p_access_all => false)
           WHERE leg = 'dense'`,
          [accessSelectiveTenantKey(), SELECTIVE_PROFILE, `[${embedText(SELECTIVE_QUERY_TEXT).join(',')}]`, K, keys],
        )
      ).rows;
    });
    const exact = await bruteForce('small');
    assert.ok(recall(exact, rows.map((row) => row.chunk_id)) < 1, `negative control recall ${rows.length} rows`);
  });

  test('below the cutoff the member gets the exact brute-force ranking (dense_mode exact)', async () => {
    const legs = await search('small');
    const exact = await bruteForce('small');
    assert.equal(exact.length, K);
    assert.deepEqual(legs.dense.map((hit) => hit.chunkId), exact);
    assert.equal(recall(exact, legs.dense.map((hit) => hit.chunkId)), 1);
    assert.equal(legs.meta?.denseMode, 'exact');
    assert.equal(legs.meta?.accessExactCutoff, 1000);
    const visible = new Set((await db.query<{ id: string }>('SELECT id::text FROM document_chunks WHERE document_id = $1', [ACCESS_SELECTIVE_IDS.docSmall])).rows.map((r) => r.id));
    assert.ok(legs.dense.every((hit) => visible.has(hit.chunkId)), 'only visible rows');
  });

  test('above the cutoff the forced relaxed iterative scan keeps recall at 1 (dense_mode ann)', async () => {
    const legs = await search('large');
    const exact = await bruteForce('large');
    assert.equal(legs.meta?.denseMode, 'ann');
    assert.equal(legs.meta?.accessIterativeScan, 'relaxed_order');
    assert.equal(legs.dense.length, K);
    assert.equal(recall(exact, legs.dense.map((hit) => hit.chunkId)), 1);
    const visible = new Set((await db.query<{ id: string }>('SELECT id::text FROM document_chunks WHERE document_id = $1', [ACCESS_SELECTIVE_IDS.docLarge])).rows.map((r) => r.id));
    assert.ok(legs.dense.every((hit) => visible.has(hit.chunkId)), 'only visible rows');
  });

  test('with an unknown pgvector version the configured iterative scan is kept; the exact floor still applies', async () => {
    const legs = await search('small', null);
    assert.equal(legs.meta?.accessIterativeScan, 'off');
    assert.equal(legs.meta?.denseMode, 'exact');
    assert.deepEqual(legs.dense.map((hit) => hit.chunkId), await bruteForce('small'));
  });

  test('the BM25 lexical leg (RAG_LEXICAL_SCORING=bm25) keeps the access filter: no chunk outside the caller\'s groups comes back', async () => {
    await db.exec('RESET enable_seqscan');
    await db.exec('RESET enable_bitmapscan');
    try {
      const tenantKey = accessSelectiveTenantKey();
      await db.query("UPDATE public.document_chunks SET lexical_tsv = to_tsvector('simple', content) WHERE tenant_key = $1", [tenantKey]);
      await db.query('SELECT public.rag_lexstats_enable($1)', [tenantKey]);
      await db.query('SELECT public.rag_lexstats_rebuild($1)', [tenantKey]);
      const lexicalSearch = async (scope: import('@/lib/rag/tenant/scope').TenantScope, tokens = ['access', 'selective']) =>
        backendFor(pgvectorVersion).search({
          scope,
          embeddingProfileId: SELECTIVE_PROFILE,
          denseVector: null,
          lexicalTokens: tokens,
          lexicalLanguages: null,
          filters: { currentOnly: true },
          denseLimit: 0,
          lexicalLimit: 50,
          access: accessModule.scopeAccessFilter(scope),
          lexicalScoring: { mode: 'bm25', k1: 1.2, b: 0.75 },
          signal: new AbortController().signal,
        } as import('@/lib/rag/backend/types').BackendSearchRequest);

      const small = await lexicalSearch(scopeFor('small'));
      assert.equal(small.meta?.lexicalScoring, 'bm25', 'served by the BM25 function, not the ts_rank_cd fallback');
      assert.ok(small.lexical.length > 0, 'the member finds their own chunks');
      assert.deepEqual([...new Set(small.lexical.map((hit) => hit.documentId))], [ACCESS_SELECTIVE_IDS.docSmall]);

      const { withAccess, mintScope } = await import('@/lib/rag/tenant/scope');
      const admin = withAccess(mintScope('personal', ACCESS_SELECTIVE_IDS.owner, null), accessModule.mintAccessScope('admin_all', []));
      // A term only one chunk of the other group carries (its seed): the member gets nothing, an admin gets that chunk.
      const otherOnly = ['400000'];
      const hidden = await lexicalSearch(scopeFor('small'), otherOnly);
      assert.equal(hidden.meta?.lexicalScoring, 'bm25');
      assert.deepEqual(hidden.lexical, [], 'a chunk of a group the member lacks never comes back');
      const all = await lexicalSearch(admin, otherOnly);
      assert.equal(all.meta?.lexicalScoring, 'bm25');
      assert.deepEqual(all.lexical.map((hit) => hit.documentId), [ACCESS_SELECTIVE_IDS.docOther], 'an admin reads the other group');
    } finally {
      await db.exec('SET enable_seqscan = off');
      await db.exec('SET enable_bitmapscan = off');
    }
  });
});
