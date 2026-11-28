import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';

// Plan 07-47 (LANG-11): one listed tenant is served by the candidate embedding profile; every other tenant keeps the active one.
const P1 = 'openai-3-small-1536';
const P2 = 'voyage-4-large-1024';
const P2_MODEL = 'voyage-4-large';
const QUERY = 'two tenant isolation canary phrase';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const P2_VECTOR = Array.from({ length: 1024 }, (_, index) => (index % 5) / 10 + 0.05);
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

const ENV = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_EMBEDDING_PROFILES: 'on',
  RAG_ROLLOUTS: 'false',
};

interface RecordedSearch {
  tenantKey: string;
  profileId: string;
  chunkIds: string[];
}

describe('rollouts: a listed tenant searches the candidate profile (multi-tenant, D-37 fixture data only)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let backendRegistry: typeof import('@/lib/rag/backend/registry');
  let ragConfig: typeof import('@/lib/rag/config');
  let ingestConfig: typeof import('@/lib/rag/ingest/config');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let registry: typeof import('@/lib/rag/embeddings/registry');
  let rollout: typeof import('@/lib/rag/rollout/resolve');
  let searches: RecordedSearch[];
  let p2Calls: string[];
  const saved: Record<string, string | undefined> = {};

  async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const client = supabaseModule.getSupabaseAdmin() as unknown as { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
    const response = await client.rpc(fn, args);
    if (response.error) throw new Error(response.error.message);
    const row = Array.isArray(response.data) && response.data.length === 1 ? (response.data[0] as Record<string, unknown>) : null;
    return row && typeof row === 'object' && fn in row ? row[fn] : response.data;
  }

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    for (const name of [...Object.keys(ENV), 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE']) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    scopeModule = await import('@/lib/rag/tenant/scope');
    backendRegistry = await import('@/lib/rag/backend/registry');
    ragConfig = await import('@/lib/rag/config');
    ingestConfig = await import('@/lib/rag/ingest/config');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    registry = await import('@/lib/rag/embeddings/registry');
    rollout = await import('@/lib/rag/rollout/resolve');

    await fixture.db.query("UPDATE embedding_profiles SET status = 'backfilling' WHERE id = $1", [P2]);
    await fixture.db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT c.id, $1, c.tenant_key, $2::halfvec, $3, 1024 FROM document_chunks c WHERE c.tenant_key IN ($4, $5)`,
      [P2, `[${P2_VECTOR.join(',')}]`, P2_MODEL, TENANT_A, TENANT_B],
    );

    p2Calls = [];
    registry.setEmbeddingProvidersForTests({
      [`voyage:${P2_MODEL}`]: {
        id: 'voyage',
        model: P2_MODEL,
        maxInputTokens: 16000,
        supportedDims: [1024, 2048],
        normalize: true,
        async embedQuery(text: string) {
          p2Calls.push(text);
          return { vectors: [P2_VECTOR], model: P2_MODEL, host: 'fake', usage: { tokens: 1 } };
        },
        async embedDocuments() {
          throw new Error('unused');
        },
      },
    } as Parameters<typeof registry.setEmbeddingProvidersForTests>[0]);
  });

  after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    registry?.resetEmbeddingProvidersForTests();
    backendRegistry?.resetRetrievalBackendForTests();
    activeProfile?.resetActiveProfileForTests();
    rollout?.resetRolloutCacheForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  function setRollouts(on: boolean): void {
    process.env.RAG_ROLLOUTS = on ? 'true' : 'false';
    ragConfig.resetRagConfigForTests();
    rollout.resetRolloutCacheForTests();
  }

  beforeEach(() => {
    ragConfig.resetRagConfigForTests();
    ingestConfig.resetIngestConfigForTests();
    activeProfile.resetActiveProfileForTests();
    rollout.resetRolloutCacheForTests();
    backendRegistry.resetRetrievalBackendForTests();
    const real = backendRegistry.getRetrievalBackend();
    searches = [];
    p2Calls.length = 0;
    const recording: RetrievalBackend = {
      id: real.id,
      health: () => real.health(),
      isReady: (scope) => real.isReady(scope),
      async search(req: BackendSearchRequest): Promise<BackendLegs> {
        const legs = await real.search(req);
        searches.push({
          tenantKey: scopeModule.scopeKey(req.scope),
          profileId: req.embeddingProfileId,
          chunkIds: [...legs.dense, ...legs.lexical].map((row) => row.chunkId),
        });
        return legs;
      },
    };
    backendRegistry.setRetrievalBackendForTests(recording);
  });

  afterEach(() => {
    backendRegistry.resetRetrievalBackendForTests();
  });

  async function retrieve(userId: string) {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return rag.runRetrieval({
      scope: resolved.scope,
      query: QUERY,
      profile: 'chat',
      options: { maxResults: 25, ragMode: 'balanced' },
      signal: new AbortController().signal,
    });
  }

  function comparable(result: Awaited<ReturnType<typeof retrieve>>) {
    return {
      status: result.status,
      reason: result.reason,
      hash: result.retrievalConfigHash,
      candidates: result.candidates.map((row) => ({ id: row.chunk_id, score: row.final_score, similarity: row.similarity })),
      stages: result.stages.map((row) => ({ name: row.name, status: row.status, counts: row.counts, detail: row.detail })),
    };
  }

  const rolloutReads = () => edge.calls.filter((call) => call.path.endsWith('/rpc/rag_rollout_active')).length;

  async function chunkKeysOf(chunkIds: string[]): Promise<string[]> {
    if (chunkIds.length === 0) return [];
    const rows = await fixture.db.query<{ tenant_key: string }>('SELECT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [chunkIds]);
    return rows.rows.map((row) => row.tenant_key);
  }

  let baselineA: ReturnType<typeof comparable>;
  let baselineB: ReturnType<typeof comparable>;
  let baselineSearchesB: RecordedSearch[];
  let rolloutId: string;

  test('switch off reads nothing: no rollout table read and both tenants search the active profile', async () => {
    setRollouts(false);
    rolloutId = (await rpc('rag_rollout_start', {
      p_kind: 'embedding_profile',
      p_candidate_ref: { embedding_profile_id: P2 },
      p_mode: 'tenants',
      p_tenants: [TENANT_A],
      p_actor: ACTOR,
    })) as string;
    assert.match(rolloutId, /^[0-9a-f-]{36}$/);
    const reads = rolloutReads();
    baselineA = comparable(await retrieve(TWO_TENANT_IDS.userA));
    baselineB = comparable(await retrieve(TWO_TENANT_IDS.userB));
    baselineSearchesB = structuredClone(searches.filter((row) => row.tenantKey === TENANT_B));
    assert.equal(rolloutReads(), reads, 'no rag_rollout_active read with RAG_ROLLOUTS=false');
    assert.ok(searches.length >= 2);
    for (const search of searches) assert.equal(search.profileId, P1);
    assert.deepEqual(p2Calls, []);
    assert.notEqual(baselineA.status, 'error', `retrieval failed: ${baselineA.reason}`);
  });

  test('switch on: tenant A embeds and searches with P2, tenant B keeps P1 and is byte-identical to the switch-off run', async () => {
    setRollouts(true);
    const resultA = await retrieve(TWO_TENANT_IDS.userA);
    assert.notEqual(resultA.status, 'error', `retrieval failed: ${resultA.reason}`);
    const searchesA = searches.filter((row) => row.tenantKey === TENANT_A);
    assert.ok(searchesA.length >= 1);
    for (const search of searchesA) assert.equal(search.profileId, P2, 'A searches the candidate profile');
    assert.deepEqual(p2Calls, [QUERY], 'A embedded with the candidate profile');
    for (const search of searchesA) assert.deepEqual([...new Set(await chunkKeysOf(search.chunkIds))].filter((key) => key !== TENANT_A), []);
    const detail = resultA.stages.find((row) => row.name === 'search')?.detail ?? '';
    assert.ok(detail.includes(`rollout=${rolloutId}:candidate`), `search span names the rollout and arm: ${detail}`);
    assert.equal(resultA.stages.find((row) => row.name === 'embed')?.detail, P2);
    assert.notEqual(resultA.retrievalConfigHash, baselineA.hash, "A's hash names the candidate profile");

    searches.length = 0;
    p2Calls.length = 0;
    const resultB = comparable(await retrieve(TWO_TENANT_IDS.userB));
    for (const search of searches) assert.equal(search.profileId, P1);
    assert.deepEqual(p2Calls, []);
    const stripRollout = (value: ReturnType<typeof comparable>) => ({
      ...value,
      stages: value.stages.map((row) => ({ ...row, detail: row.detail?.replace(/\s*rollout=\S+/g, '') || undefined })),
    });
    assert.ok(
      resultB.stages.find((row) => row.name === 'search')?.detail?.includes(`rollout=${rolloutId}:incumbent`),
      'B records the incumbent arm',
    );
    assert.deepEqual(stripRollout(resultB), stripRollout(baselineB));
    assert.equal(resultB.hash, baselineB.hash, "B's hash is unchanged");
    assert.deepEqual(searches, baselineSearchesB, "B's backend requests equal the switch-off run");
  });

  test('per-tenant exclusion returns A to P1 after the cache; rollback ends the rollout; nothing is deleted', async () => {
    setRollouts(true);
    const vectorsBefore = Number((await fixture.db.query<{ n: number }>('SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1', [P2])).rows[0]?.n);
    assert.equal(await rpc('rag_rollout_set_tenant', { p_rollout_id: rolloutId, p_tenant_key: TENANT_A, p_membership: 'exclude', p_actor: ACTOR }), 'exclude');
    rollout.resetRolloutCacheForTests();
    await retrieve(TWO_TENANT_IDS.userA);
    for (const search of searches) assert.equal(search.profileId, P1);

    assert.equal(await rpc('rag_rollout_rollback', { p_rollout_id: rolloutId, p_actor: ACTOR }), 'rolled_back');
    const active = (await rpc('rag_rollout_active', {})) as unknown[];
    assert.deepEqual(active, []);
    const vectorsAfter = Number((await fixture.db.query<{ n: number }>('SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1', [P2])).rows[0]?.n);
    assert.equal(vectorsAfter, vectorsBefore, 'rollback deleted no vector');
  });

  test('starting a second active rollout of the same kind is refused; an active profile cannot be a candidate', async () => {
    const id = (await rpc('rag_rollout_start', {
      p_kind: 'embedding_profile',
      p_candidate_ref: { embedding_profile_id: P2 },
      p_mode: 'share',
      p_share_percent: 10,
      p_actor: ACTOR,
    })) as string;
    await assert.rejects(
      rpc('rag_rollout_start', { p_kind: 'embedding_profile', p_candidate_ref: { embedding_profile_id: P2 }, p_mode: 'tenants', p_tenants: [TENANT_B] }),
      /rollout_refused: active_exists/,
    );
    await rpc('rag_rollout_finish', { p_rollout_id: id, p_state: 'cancelled', p_actor: ACTOR });
    await assert.rejects(
      rpc('rag_rollout_start', { p_kind: 'embedding_profile', p_candidate_ref: { embedding_profile_id: P1 }, p_mode: 'tenants', p_tenants: [TENANT_B] }),
      /rollout_refused: candidate_is_incumbent/,
    );
    await assert.rejects(
      rpc('rag_rollout_set_tenant', { p_rollout_id: id, p_tenant_key: 's:default', p_membership: 'include' }),
      /tenant key not valid for this deployment mode/,
    );
  });

  test('the bucket in SQL equals the TypeScript bucket', async () => {
    const salt = 'paritysalt01';
    for (let i = 0; i < 200; i += 1) {
      const key = `u:${crypto.randomUUID()}`;
      const rows = await fixture.db.query<{ b: number }>('SELECT public.rag_rollout_bucket($1, $2) AS b', [salt, key]);
      assert.equal(Number(rows.rows[0]?.b), rollout.rolloutBucket(salt, key), key);
    }
  });

  for (const role of ['anon', 'authenticated'] as const) {
    test(`${role} can read no rollout table and call no rollout function`, async () => {
      const statements = [
        'SELECT * FROM public.rag_rollouts',
        'SELECT * FROM public.rag_rollout_tenants',
        'SELECT * FROM public.rag_rollout_active()',
        `SELECT public.rag_rollout_bucket('paritysalt01', '${TENANT_A}')`,
        `SELECT public.rag_rollout_set_tenant('${crypto.randomUUID()}', '${TENANT_A}', 'include', NULL)`,
        `SELECT public.rag_rollout_rollback('${crypto.randomUUID()}', NULL)`,
        `SELECT public.rag_rollout_start('embedding_profile', '{"embedding_profile_id":"${P2}"}'::jsonb, 'tenants', NULL, NULL, NULL)`,
      ];
      for (const sql of statements) {
        await fixture.db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(fixture.db.query(sql), (error: { code?: string }) => error.code === '42501', sql);
        } finally {
          await fixture.db.exec('RESET ROLE');
        }
      }
    });
  }
});
