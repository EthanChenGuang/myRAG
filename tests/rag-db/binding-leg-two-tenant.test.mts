import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';

const LEGACY = 'openai-3-small-1536';
const LAW = 'voyage-law-2-1024';
const LAW_MODEL = 'voyage-law-2';
const CONTRACT = 'contract_legal';
const QUERY = 'two tenant isolation canary phrase';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const LAW_VECTOR = Array.from({ length: 1024 }, (_, index) => (index % 7) / 10 + 0.05);

const ENV = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'none',
  RAG_REFUSAL_THRESHOLD: 'false',
  RAG_EMBEDDING_PROFILES: 'on',
  RAG_DOMAIN_EMBEDDINGS: 'on',
};

interface RecordedSearch {
  tenantKey: string;
  profileId: string;
  docTypes: string[] | undefined;
  chunkIds: string[];
  documentIds: string[];
}

describe('binding legs on the real search function, two tenants (D-27)', () => {
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
  let bindings: typeof import('@/lib/rag/embeddings/bindings');
  let registry: typeof import('@/lib/rag/embeddings/registry');
  let searches: RecordedSearch[];
  let lawCalls: string[];
  const saved: Record<string, string | undefined> = {};
  const contractChunks: Record<string, string> = {};
  const contractDocs: Record<string, string> = {};

  async function seedContract(tenantKey: string, userId: string): Promise<void> {
    const documentId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    await fixture.db.query('INSERT INTO documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
      documentId,
      `binding-${userId.slice(-2)}.md`,
      'A neutral synthetic paragraph about a sample record.',
      '{}',
      userId,
      CONTRACT,
    ]);
    await fixture.db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, 0, $4::jsonb)', [
      chunkId,
      documentId,
      'A neutral synthetic sentence for the binding leg.',
      '{}',
    ]);
    const tenant = await fixture.db.query<{ tenant_key: string }>('SELECT tenant_key FROM document_chunks WHERE id = $1', [chunkId]);
    assert.equal(tenant.rows[0]?.tenant_key, tenantKey, 'the chunk carries its tenant key');
    await fixture.db.query(
      `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
       SELECT c.id, $2, c.tenant_key, $3::halfvec, $4, 1024 FROM document_chunks c WHERE c.id = $1`,
      [chunkId, LAW, `[${LAW_VECTOR.join(',')}]`, LAW_MODEL],
    );
    contractChunks[tenantKey] = chunkId;
    contractDocs[tenantKey] = documentId;
  }

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    for (const name of Object.keys(ENV)) saved[name] = process.env[name];
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
    bindings = await import('@/lib/rag/embeddings/bindings');
    registry = await import('@/lib/rag/embeddings/registry');

    await seedContract(TENANT_A, TWO_TENANT_IDS.userA);
    await seedContract(TENANT_B, TWO_TENANT_IDS.userB);

    lawCalls = [];
    registry.setEmbeddingProvidersForTests({
      [`voyage:${LAW_MODEL}`]: {
        id: 'voyage',
        model: LAW_MODEL,
        maxInputTokens: 16000,
        supportedDims: [1024],
        normalize: true,
        async embedQuery(text: string) {
          lawCalls.push(text);
          return { vectors: [LAW_VECTOR], model: LAW_MODEL, host: 'fake', usage: { tokens: 1 } };
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
    bindings?.resetBindingsForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  beforeEach(async () => {
    await fixture.db.query('DELETE FROM embedding_profile_bindings');
    ragConfig.resetRagConfigForTests();
    ingestConfig.resetIngestConfigForTests();
    activeProfile.resetActiveProfileForTests();
    bindings.resetBindingsForTests();
    backendRegistry.resetRetrievalBackendForTests();
    const real = backendRegistry.getRetrievalBackend();
    searches = [];
    lawCalls.length = 0;
    const recording: RetrievalBackend = {
      id: real.id,
      health: () => real.health(),
      isReady: () => real.isReady(),
      async search(req: BackendSearchRequest): Promise<BackendLegs> {
        const legs = await real.search(req);
        const rows = [...legs.dense, ...legs.lexical];
        searches.push({
          tenantKey: scopeModule.scopeKey(req.scope),
          profileId: req.embeddingProfileId,
          docTypes: req.filters.docTypes,
          chunkIds: rows.map((row) => row.chunkId),
          documentIds: rows.map((row) => row.documentId),
        });
        return legs;
      },
    };
    backendRegistry.setRetrievalBackendForTests(recording);
  });

  afterEach(() => {
    backendRegistry.resetRetrievalBackendForTests();
  });

  async function activeBinding(tenantKey: string | null): Promise<void> {
    await fixture.db.query(
      `INSERT INTO embedding_profile_bindings (doc_type, tenant_key, profile_id, status, eval_evidence, activated_at, activated_by, created_by)
       VALUES ($1, $2, $3, 'active', $4::jsonb, now(), 'test', 'test')`,
      [CONTRACT, tenantKey, LAW, JSON.stringify({ baseline_global_profile: LEGACY })],
    );
    bindings.resetBindingsForTests();
  }

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
      candidates: result.candidates.map((row) => ({ id: row.chunk_id, score: row.final_score, similarity: row.similarity, legs: row.legs })),
      stages: result.stages.map((row) => ({ name: row.name, status: row.status, counts: row.counts, detail: row.detail })),
    };
  }

  test('a deployment-wide binding leg searches with the request tenant key and returns no chunk of another tenant', async () => {
    await activeBinding(null);
    const result = await retrieve(TWO_TENANT_IDS.userA);
    assert.notEqual(result.status, 'error', `retrieval failed: ${result.reason}`);
    const lawSearches = searches.filter((row) => row.profileId === LAW);
    assert.equal(lawSearches.length, 1, 'one binding leg ran');
    assert.equal(lawSearches[0]!.tenantKey, TENANT_A);
    assert.deepEqual(lawSearches[0]!.docTypes, [CONTRACT]);
    assert.deepEqual(lawSearches[0]!.chunkIds, [contractChunks[TENANT_A]], 'the binding leg finds tenant A contract chunk only');
    for (const search of searches) {
      assert.equal(search.tenantKey, TENANT_A);
      assert.ok(!search.chunkIds.includes(contractChunks[TENANT_B]!), `${search.profileId} leg returned tenant B's chunk`);
      assert.ok(!search.documentIds.includes(TWO_TENANT_IDS.docB) && !search.documentIds.includes(contractDocs[TENANT_B]!));
    }
    assert.ok(!result.candidates.some((row) => row.chunk_id === contractChunks[TENANT_B]));
    assert.deepEqual(result.stages.find((row) => row.name === 'search')?.counts, { dense: searches[0]!.chunkIds.length, lexical: 0, domain: 1 });
    assert.deepEqual(lawCalls, [QUERY]);

    searches.length = 0;
    await retrieve(TWO_TENANT_IDS.userB);
    const control = searches.find((row) => row.profileId === LAW);
    assert.equal(control?.tenantKey, TENANT_B);
    assert.deepEqual(control?.chunkIds, [contractChunks[TENANT_B]], "control: B's own leg finds B's contract chunk");
  });

  test('a tenant binding for B only runs no binding leg for an A request', async () => {
    await activeBinding(TENANT_B);
    const result = await retrieve(TWO_TENANT_IDS.userA);
    assert.notEqual(result.status, 'error', `retrieval failed: ${result.reason}`);
    assert.deepEqual(searches.map((row) => row.profileId), [LEGACY]);
    assert.deepEqual(lawCalls, []);
  });

  test("parity: with A bound only, B's result, trace and config hash equal a run with no binding rows", async () => {
    const unbound = comparable(await retrieve(TWO_TENANT_IDS.userB));
    const unboundSearches = structuredClone(searches);
    searches.length = 0;

    await activeBinding(TENANT_A);
    const boundA = comparable(await retrieve(TWO_TENANT_IDS.userB));
    assert.deepEqual(boundA, unbound);
    assert.deepEqual(searches, unboundSearches);
    assert.deepEqual(lawCalls, [], 'no law-2 request for tenant B');
  });

  test('a request with no TenantScope returns no_tenant before any binding read', async () => {
    await activeBinding(null);
    const reads = edge.calls.filter((call) => call.path.endsWith('/rpc/rag_list_embedding_bindings')).length;
    const result = await rag.runRetrieval({ scope: null, query: QUERY, profile: 'chat', signal: new AbortController().signal });
    assert.equal(result.reason, 'no_tenant');
    assert.equal(edge.calls.filter((call) => call.path.endsWith('/rpc/rag_list_embedding_bindings')).length, reads);
    assert.deepEqual(searches, []);
    assert.deepEqual(lawCalls, []);
  });
});
