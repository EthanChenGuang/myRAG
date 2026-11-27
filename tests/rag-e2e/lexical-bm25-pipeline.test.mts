import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { runFixtureRelex } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;
type RetrievalResult = import('@/lib/rag/types').RetrievalResult;
type BackendSearchRequest = import('@/lib/rag/backend/types').BackendSearchRequest;
type BackendLegs = import('@/lib/rag/backend/types').BackendLegs;
type RetrievalBackend = import('@/lib/rag/backend/types').RetrievalBackend;

const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const QUESTION = 'w5 w7 canary';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true, ragMode: 'balanced' as const };
const V2_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
};
const BM25_ENV = { RAG_LEXICAL_SCORING: 'bm25', RAG_LEXICAL_BM25_K1: '1.2', RAG_LEXICAL_BM25_B: '0.75' };

/** Neutral synthetic chunks (D-41): generated tokens with different frequencies and lengths. */
const CHUNKS = [
  'Synthetic note w5 w5 w5 w7 canary',
  'Synthetic note w5 w2 w3 w4 w6 w8 w9 w10 w11 w12 w13',
  'Synthetic note w7 w7 w1 canary canary',
  'Synthetic note w1 w2 w3',
  'Synthetic note w5 w7 w9 w11 w13 w15 w17 w19 w21 canary',
].map((text, index) => ({
  text,
  docId: `00000000-0000-4000-8000-00000000a6${String(index).padStart(2, '0')}`,
  chunkId: `00000000-0000-4000-8000-00000000a7${String(index).padStart(2, '0')}`,
}));

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

describe('BM25 lexical leg through the v2 pipeline (LEX-04, LEX-05, D-25, D-40)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let configModule: typeof import('@/lib/rag/config');
  let registryModule: typeof import('@/lib/rag/backend/registry');
  let statsModule: typeof import('@/lib/rag/lexical/stats');
  let languageSettings: typeof import('@/lib/rag/lang/settings');
  const saved: Record<string, string | undefined> = {};
  const recorded: Array<{ req: BackendSearchRequest; legs: BackendLegs }> = [];

  before(async () => {
    fixture = await createTwoTenantDatabase({ relex: false });
    for (const chunk of CHUNKS) {
      await fixture.db.query("INSERT INTO documents (id, filename, content, user_id, language) VALUES ($1, 'synthetic.md', $2, $3, 'en')", [
        chunk.docId,
        chunk.text,
        TWO_TENANT_IDS.userA,
      ]);
      await fixture.db.query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, tenant_key, language, doc_type)
         VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb, $5, 'en', 'general')`,
        [chunk.chunkId, chunk.docId, chunk.text, vec(chunk.text), TENANT_A],
      );
    }
    await runFixtureRelex(fixture.db);
    edge = await startFakeEdge({ db: fixture.db });
    for (const name of [...Object.keys(V2_ENV), ...Object.keys(BM25_ENV)]) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), V2_ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    configModule = await import('@/lib/rag/config');
    registryModule = await import('@/lib/rag/backend/registry');
    statsModule = await import('@/lib/rag/lexical/stats');
    languageSettings = await import('@/lib/rag/lang/settings');
    configModule.resetRagConfigForTests();
    registryModule.resetRetrievalBackendForTests();
    const real = registryModule.getRetrievalBackend();
    const recording = Object.create(real) as RetrievalBackend;
    Object.defineProperty(recording, 'search', {
      value: async (req: BackendSearchRequest) => {
        const legs = await real.search(req);
        recorded.push({ req, legs });
        return legs;
      },
    });
    registryModule.setRetrievalBackendForTests(recording);
  });

  after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    configModule?.resetRagConfigForTests();
    registryModule?.resetRetrievalBackendForTests();
    statsModule?.resetLexstatsCacheForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  const scopeOf = async (userId: string): Promise<TenantScope> => {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  };

  const retrieve = async (env: Record<string, string> = {}) => {
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(env)) {
      previous[name] = process.env[name];
      process.env[name] = value;
    }
    configModule.resetRagConfigForTests();
    languageSettings.resetLanguageSettingsForTests();
    recorded.length = 0;
    try {
      const scope = await scopeOf(TWO_TENANT_IDS.userA);
      const start = edge.calls.length;
      const result: RetrievalResult = await rag.runRetrieval({ scope, query: QUESTION, profile: 'chat', options: OPTIONS, signal: new AbortController().signal });
      return { result, calls: edge.calls.slice(start).map((call) => call.path), searches: [...recorded] };
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      configModule.resetRagConfigForTests();
      languageSettings.resetLanguageSettingsForTests();
    }
  };

  const searchStage = (result: RetrievalResult) => result.stages.find((entry) => entry.name === 'search');
  const view = (result: RetrievalResult) => ({
    status: result.status,
    candidates: result.candidates.map((entry) => [entry.chunk_id, entry.similarity]),
  });
  const lexicalScoringRpcs = (calls: string[]) =>
    calls.filter((path) => path.endsWith('/rpc/rag_bm25_search_chunks') || path.endsWith('/rpc/rag_lexstats_status'));

  let baseline: ReturnType<typeof view>;

  test('ts_rank_cd: no statistics RPC, no BM25 call, no lexical scoring code', async () => {
    const { result, calls, searches } = await retrieve();
    assert.ok(result.stages.some((entry) => entry.name === 'fuse'), 'the v2 graph ran');
    assert.deepEqual(lexicalScoringRpcs(calls), []);
    for (const { req } of searches) assert.equal('lexicalScoring' in req, false);
    assert.ok(!(searchStage(result)?.detail ?? '').includes('lexical_'), 'no lexical scoring code');
    assert.ok(searches.some(({ legs }) => legs.lexical.length > 0), 'the ts_rank_cd lexical leg found the synthetic chunks');
    baseline = view(result);
    assert.ok(baseline.candidates.length > 0);
  });

  test('bm25 with the tenant not enabled: served by ts_rank_cd with lexical_stats_unavailable, same result as ts_rank_cd', async () => {
    statsModule.resetLexstatsCacheForTests();
    const { result, calls } = await retrieve(BM25_ENV);
    assert.ok(calls.some((path) => path.endsWith('/rpc/rag_lexstats_status')));
    assert.ok(!calls.some((path) => path.endsWith('/rpc/rag_bm25_search_chunks')), 'no BM25 call for a tenant that is not ready');
    assert.ok((searchStage(result)?.detail ?? '').split(';').includes('lexical_stats_unavailable'));
    assert.notEqual(searchStage(result)?.status, 'error');
    assert.deepEqual(view(result), baseline, 'status, candidates and similarity equal the ts_rank_cd run');
  });

  test('bm25 with ready statistics: the lexical leg carries the scores of a direct rag_bm25_search_chunks call', async () => {
    await fixture.db.query('SELECT rag_lexstats_enable($1)', [TENANT_A]);
    await fixture.db.query('SELECT rag_lexstats_rebuild($1)', [TENANT_A]);
    statsModule.resetLexstatsCacheForTests();
    const { result, calls, searches } = await retrieve(BM25_ENV);
    assert.ok(calls.some((path) => path.endsWith('/rpc/rag_bm25_search_chunks')));
    assert.ok((searchStage(result)?.detail ?? '').split(';').includes('lexical_scoring_bm25'));
    assert.ok(result.candidates.length > 0, 'the fused result is non-empty');

    const original = searches.find(({ req }) => req.lexicalTokens.length > 0 && req.lexicalLimit > 0);
    assert.ok(original, 'a lexical search ran');
    assert.deepEqual(original.req.lexicalScoring, { mode: 'bm25', k1: 1.2, b: 0.75 });
    assert.equal(original.legs.meta?.lexicalScoring, 'bm25');
    const direct = await fixture.db.query<{ chunk_id: string; lexical_score: number }>(
      `SELECT chunk_id, lexical_score FROM rag_bm25_search_chunks(
         p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_lexical_limit => $5,
         p_lexical_languages => $6::text[], p_k1 => 1.2, p_b => 0.75, p_candidate_limit => $7)`,
      [
        TENANT_A,
        original.req.embeddingProfileId,
        vec(QUESTION),
        original.req.lexicalTokens,
        original.req.lexicalLimit,
        original.req.lexicalLanguages && original.req.lexicalLanguages.length > 0 ? original.req.lexicalLanguages : null,
        Math.min(2000, Math.max(500, 5 * original.req.lexicalLimit)),
      ],
    );
    assert.ok(direct.rows.length > 0, 'the direct call finds the synthetic chunks');
    assert.deepEqual(
      original.legs.lexical.map((hit) => [hit.chunkId, hit.lexicalScore]),
      direct.rows.map((row) => [row.chunk_id, row.lexical_score]),
    );
  });

  test('ts_rank_cd after enabling: still no BM25 call and the baseline result', async () => {
    const { result, calls } = await retrieve();
    assert.deepEqual(lexicalScoringRpcs(calls), []);
    assert.deepEqual(view(result), baseline);
  });
});
