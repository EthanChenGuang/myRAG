import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const LEGACY = 'openai-3-small-1536';
const PROFILE_A = 'test-a-1536';
const PROFILE_B = 'test-b-1536';
const MODEL = 'test-model';
const QUERY = 'two tenant isolation canary phrase';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };

function literal(values: number[]): string {
  return `[${values.join(',')}]`;
}

function chunkId(n: number): string {
  return `00000000-0000-4000-8000-${String(910000 + n).padStart(12, '0')}`;
}

describe('retrieval through the active embedding profile on the two-tenant fixture', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let supabaseModule: typeof import('@/lib/supabase');
  let ingestDeps: typeof import('@/lib/rag/ingest/deps');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');
  let registry: typeof import('@/lib/rag/embeddings/registry');
  let failureLog: typeof import('@/lib/rag/embeddings/query-embedding');
  let providerCalls: { dims: number }[];
  let mode: 'on' | 'off';

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    scopeModule = await import('@/lib/rag/tenant/scope');
    supabaseModule = await import('@/lib/supabase');
    ingestDeps = await import('@/lib/rag/ingest/deps');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    registry = await import('@/lib/rag/embeddings/registry');
    failureLog = await import('@/lib/rag/embeddings/query-embedding');

    providerCalls = [];
    registry.setEmbeddingProvidersForTests({
      openai: {
        id: 'openai',
        model: MODEL,
        maxInputTokens: 8000,
        supportedDims: [1536],
        normalize: true,
        async embedQuery(text, opts) {
          providerCalls.push({ dims: opts.dims });
          return { vectors: [embedText(text)], model: MODEL, host: 'fake', usage: { tokens: 1 } };
        },
        async embedDocuments() {
          throw new Error('unused');
        },
      },
    });

    for (const id of [PROFILE_A, PROFILE_B]) {
      await fixture.db.query(
        `INSERT INTO embedding_profiles (id, provider, model, dims, storage, status) VALUES ($1, 'openai', $2, 1536, 'halfvec', 'available')`,
        [id, MODEL],
      );
      await fixture.db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT id, $1, tenant_key, embedding::halfvec(1536), $2, 1536 FROM document_chunks WHERE embedding IS NOT NULL`,
        [id, MODEL],
      );
    }
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = $1", [LEGACY]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [PROFILE_A]);
    switchTo('on');
  });

  after(async () => {
    registry.resetEmbeddingProvidersForTests();
    ingestDeps.resetIngestDepsForTests();
    activeProfile.resetActiveProfileForTests();
    await edge?.close();
    await fixture?.db.close();
  });

  afterEach(async () => {
    await pointTo(PROFILE_A);
    mode = 'on';
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: mode }) });
    activeProfile.resetActiveProfileForTests();
    failureLog.resetProfileFailureLogForTests();
  });

  function switchTo(next: 'on' | 'off'): void {
    mode = next;
    ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: next }) });
    activeProfile.resetActiveProfileForTests();
  }

  const resolve = (userId: string | null, organizationId: string | null) =>
    resolver.resolveTenantScope({
      requestedOrganizationId: organizationId,
      deploymentMode: 'multi-tenant',
      getUser: async () => (userId ? { id: userId } : null),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });

  async function retrieve(userId: string | null, organizationId: string | null, query = QUERY) {
    const resolved = await resolve(userId, organizationId);
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return rag.runRetrieval({ scope: resolved.scope, query, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });
  }

  const documents = (result: Awaited<ReturnType<typeof retrieve>>): string[] =>
    [...new Set(result.candidates.map((candidate) => candidate.document_id))].sort();

  const searchPaths = (): number =>
    edge.calls.filter((call) => call.path.endsWith('/rpc/match_chunks_by_profile')).length;

  test('each tenant retrieves the same documents through the profile as with the switch off, and nothing from another tenant', async () => {
    const tenants: [string | null, string | null][] = [
      [TWO_TENANT_IDS.userA, null],
      [TWO_TENANT_IDS.userB, null],
      [TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO],
    ];
    const expectedOwn = [TWO_TENANT_IDS.docA, TWO_TENANT_IDS.docB, TWO_TENANT_IDS.docO];
    for (const [index, [userId, orgId]] of tenants.entries()) {
      switchTo('off');
      const legacy = await retrieve(userId, orgId);
      switchTo('on');
      const before = searchPaths();
      const profiled = await retrieve(userId, orgId);
      assert.ok(searchPaths() > before, 'the profile RPC must be used');
      assert.deepEqual(documents(profiled), documents(legacy), `tenant ${index}`);
      assert.deepEqual(documents(profiled), [expectedOwn[index]], `tenant ${index} sees only its own document`);
      assert.equal(profiled.status, 'ok');
    }
    assert.deepEqual(providerCalls.every((call) => call.dims === 1536), true);
  });

  test('the switch off issues no profile search and no registry read', async () => {
    switchTo('off');
    const searches = searchPaths();
    const registryReads = edge.calls.filter((call) => call.path.endsWith('/rpc/rag_list_embedding_profiles')).length;
    const legacyCalls = edge.calls.filter((call) => call.path.endsWith('/rpc/match_documents_by_workspace')).length;
    const result = await retrieve(TWO_TENANT_IDS.userA, null);
    assert.equal(result.status, 'ok');
    assert.equal(searchPaths(), searches);
    assert.equal(edge.calls.filter((call) => call.path.endsWith('/rpc/rag_list_embedding_profiles')).length, registryReads);
    assert.ok(edge.calls.filter((call) => call.path.endsWith('/rpc/match_documents_by_workspace')).length > legacyCalls);
  });

  test('quarantined and superseded chunks are absent from profile search and appear once ready and current', async () => {
    const query = embedText(QUERY);
    const hidden = [
      [chunkId(1), 'quarantined', true, 21],
      [chunkId(2), 'ready', false, 22],
    ] as const;
    for (const [id, status, current, index] of hidden) {
      await fixture.db.query(
        'INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, status, is_current) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
        [id, TWO_TENANT_IDS.docA, `hidden chunk ${index}`, index, '{}', status, current],
      );
      await fixture.db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT c.id, $2, c.tenant_key, $3::halfvec, $4, 1536 FROM document_chunks c WHERE c.id = $1`,
        [id, PROFILE_A, literal(query), MODEL],
      );
    }
    switchTo('on');
    const absent = await retrieve(TWO_TENANT_IDS.userA, null);
    const ids = absent.candidates.map((candidate) => candidate.chunk_id);
    assert.ok(!ids.includes(chunkId(1)) && !ids.includes(chunkId(2)), 'hidden chunks must not be returned');

    await fixture.db.query("UPDATE document_chunks SET status = 'ready' WHERE id = $1", [chunkId(1)]);
    await fixture.db.query('UPDATE document_chunks SET is_current = true WHERE id = $1', [chunkId(2)]);
    activeProfile.resetActiveProfileForTests();
    const control = await retrieve(TWO_TENANT_IDS.userA, null);
    const controlIds = control.candidates.map((candidate) => candidate.chunk_id);
    assert.ok(controlIds.includes(chunkId(1)) && controlIds.includes(chunkId(2)), 'control: both appear once ready and current');

    const other = await retrieve(TWO_TENANT_IDS.userB, null);
    assert.ok(!other.candidates.some((candidate) => candidate.chunk_id === chunkId(1) || candidate.chunk_id === chunkId(2)));
  });

  async function pointTo(id: string): Promise<void> {
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE id = ANY($1::text[]) AND status = 'active'", [[PROFILE_A, PROFILE_B]]);
    await fixture.db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [id]);
  }

  test('a stale pointer is refreshed once and the request is retried with the new active profile', async () => {
    switchTo('on');
    const warm = await retrieve(TWO_TENANT_IDS.userA, null);
    assert.equal(warm.status, 'ok');
    const registryReads = () => edge.calls.filter((call) => call.path.endsWith('/rpc/rag_list_embedding_profiles')).length;

    await pointTo(PROFILE_B);

    const readsBefore = registryReads();
    const searchesBefore = searchPaths();
    const providerBefore = providerCalls.length;
    const result = await retrieve(TWO_TENANT_IDS.userA, null);

    assert.equal(result.status, 'ok');
    assert.deepEqual(documents(result), [TWO_TENANT_IDS.docA]);
    assert.equal(registryReads() - readsBefore, 1, 'exactly one refresh');
    assert.equal(searchPaths() - searchesBefore, 2, 'the failed search and exactly one retry');
    assert.equal(providerCalls.length - providerBefore, 2, 'the query is embedded again for the new profile');

    const after = await retrieve(TWO_TENANT_IDS.userA, null);
    assert.equal(after.status, 'ok');
    assert.equal(registryReads() - readsBefore, 1, 'the refreshed pointer is cached');
    await pointTo(PROFILE_A);
  });

  test('a database that has no active profile row for the pointer gives status error, not an empty answer', async () => {
    switchTo('on');
    await fixture.db.query("UPDATE embedding_profiles SET status = 'available' WHERE status = 'active'");
    try {
      const result = await retrieve(TWO_TENANT_IDS.userA, null);
      assert.equal(result.status, 'error');
      assert.equal(result.reason, 'embedding_profile_unavailable');
      assert.equal(result.refusalCandidate, false);
    } finally {
      await pointTo(PROFILE_A);
    }
  });

  test('the scope kind decides the tenant key: a personal scope can never search an organization key', async () => {
    switchTo('on');
    const resolved = await resolve(TWO_TENANT_IDS.userB, TWO_TENANT_IDS.orgO);
    assert.deepEqual(resolved, { ok: false, status: 403, reason: 'not_a_member' });
    const personal = await resolve(TWO_TENANT_IDS.userB, null);
    assert.ok(personal.ok && personal.scope);
    assert.equal(scopeModule.scopeKey(personal.scope), `u:${TWO_TENANT_IDS.userB}`);
    const result = await rag.runRetrieval({ scope: personal.scope, query: QUERY, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });
    assert.deepEqual(documents(result), [TWO_TENANT_IDS.docB]);
  });
});
