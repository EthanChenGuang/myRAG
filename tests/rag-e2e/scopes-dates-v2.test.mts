import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

type RetrievalFilterInput = import('@/lib/rag/backend/types').RetrievalFilterInput;
type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;

const QUERY = 'two tenant isolation canary phrase';
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const V2_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false', RAG_SCOPE_TAGS: 'true' };
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const ACTOR = '00000000-0000-4000-8000-0000000000f9';

const DOCS = {
  aTagged: { docId: '00000000-0000-4000-8000-00000000a101', chunkId: '00000000-0000-4000-8000-00000000a1c1', userId: TWO_TENANT_IDS.userA, scopes: ['region:a1'] },
  aUntagged: { docId: '00000000-0000-4000-8000-00000000a102', chunkId: '00000000-0000-4000-8000-00000000a1c2', userId: TWO_TENANT_IDS.userA, scopes: [] },
  aOtherValue: { docId: '00000000-0000-4000-8000-00000000a103', chunkId: '00000000-0000-4000-8000-00000000a1c3', userId: TWO_TENANT_IDS.userA, scopes: ['region:b2'] },
  bTagged: { docId: '00000000-0000-4000-8000-00000000b101', chunkId: '00000000-0000-4000-8000-00000000b1c1', userId: TWO_TENANT_IDS.userB, scopes: ['region:a1'] },
} as const;

function vectorLiteral(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

describe('scopes filter and effective dates through the v2 pipeline, two tenants', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let scopesModule: typeof import('@/lib/rag/query/scopes');
  let filtersModule: typeof import('@/lib/rag/query/filters');
  let configModule: typeof import('@/lib/rag/config');
  const saved: Record<string, string | undefined> = {};

  async function seedDocument(doc: (typeof DOCS)[keyof typeof DOCS], label: string) {
    const text = `Two tenant isolation canary phrase: scoped sample ${label}`;
    await fixture.db.query('INSERT INTO documents (id, filename, content, user_id, scopes) VALUES ($1, $2, $3, $4, $5::text[])', [
      doc.docId,
      `${label}.md`,
      text,
      doc.userId,
      doc.scopes,
    ]);
    await fixture.db.query(
      'INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, scopes) VALUES ($1, $2, $3, $4::vector, 0, $5::jsonb, $6::text[])',
      [doc.chunkId, doc.docId, `Document: ${label}.md. Content: ${text}`, vectorLiteral(text), '{}', doc.scopes],
    );
  }

  async function seedVocabulary(tenantKey: string, value: string) {
    await fixture.db.query(
      `INSERT INTO rag_scope_vocabulary (tenant_key, dimension, value, label, created_by, updated_by) VALUES ($1, 'region', $2, $3, $4, $4)`,
      [tenantKey, value, `Label ${value}`, ACTOR],
    );
  }

  before(async () => {
    fixture = await createTwoTenantDatabase();
    await seedDocument(DOCS.aTagged, 'a-tagged');
    await seedDocument(DOCS.aUntagged, 'a-untagged');
    await seedDocument(DOCS.aOtherValue, 'a-other');
    await seedDocument(DOCS.bTagged, 'b-tagged');
    await seedVocabulary(TENANT_A, 'a1');
    await seedVocabulary(TENANT_A, 'b2');
    await seedVocabulary(TENANT_B, 'a1');
    edge = await startFakeEdge({ db: fixture.db });
    for (const name of ['RAG_EFFECTIVE_DATES', ...Object.keys(V2_ENV)]) saved[name] = process.env[name];
    Object.assign(process.env, fixtureProcessEnv(edge.url), V2_ENV);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    scopesModule = await import('@/lib/rag/query/scopes');
    filtersModule = await import('@/lib/rag/query/filters');
    configModule = await import('@/lib/rag/config');
    const { resetRetrievalBackendForTests } = await import('@/lib/rag/backend/registry');
    configModule.resetRagConfigForTests();
    resetRetrievalBackendForTests();
  });

  after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

  /** Parses the body field and checks the vocabulary the way the chat route does, then runs v2 retrieval. */
  const retrieve = async (userId: string, body: unknown) => {
    const scope = await scopeOf(userId);
    const parsed = filtersModule.parseRetrievalFilters(body);
    assert.ok(parsed.ok, 'the body filter parses');
    const filters: RetrievalFilterInput | undefined = await scopesModule.resolveScopesFilter(parsed.filters, { scope });
    const start = edge.calls.length;
    const result = await rag.runRetrieval({
      scope,
      query: QUERY,
      profile: 'chat',
      options: { ...OPTIONS, ragMode: 'balanced' },
      signal: new AbortController().signal,
      ...(filters ? { retrievalFilters: filters } : {}),
    });
    assert.ok(result.stages.some((entry) => entry.name === 'fuse'), 'the v2 graph ran');
    return { docs: new Set(result.candidates.map((candidate) => candidate.document_id)), calls: edge.calls.slice(start) };
  };

  test('a scopes filter returns chunks of the tagged document only', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['a1'] } });
    assert.deepEqual([...docs], [DOCS.aTagged.docId]);
  });

  test('values of one dimension are OR', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['b2', 'a1'] } });
    assert.deepEqual([...docs].sort(), [DOCS.aTagged.docId, DOCS.aOtherValue.docId].sort());
  });

  test('includeUntagged also admits documents with no tag in that dimension', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['a1'] }, includeUntagged: true });
    assert.ok(docs.has(DOCS.aTagged.docId));
    assert.ok(docs.has(DOCS.aUntagged.docId));
    assert.ok(docs.has(TWO_TENANT_IDS.docA));
    assert.ok(!docs.has(DOCS.aOtherValue.docId), 'a document tagged with another value of the dimension stays out');
    assert.ok(!docs.has(DOCS.bTagged.docId));
  });

  test('without a filter every document of the tenant is searched', async () => {
    const { docs } = await retrieve(TWO_TENANT_IDS.userA, undefined);
    for (const id of [DOCS.aTagged.docId, DOCS.aUntagged.docId, DOCS.aOtherValue.docId, TWO_TENANT_IDS.docA]) assert.ok(docs.has(id), id);
    assert.ok(!docs.has(DOCS.bTagged.docId));
  });

  test("tenant B's identically tagged document never appears for tenant A, and the other way round", async () => {
    const a = await retrieve(TWO_TENANT_IDS.userA, { scopes: { region: ['a1'] }, includeUntagged: true });
    assert.ok(!a.docs.has(DOCS.bTagged.docId));
    for (const call of a.calls) {
      const named = decodeURIComponent(call.query ?? '');
      assert.ok(!named.includes(DOCS.bTagged.docId), `A's request ${call.path} named B's document`);
    }
    const b = await retrieve(TWO_TENANT_IDS.userB, { scopes: { region: ['a1'] } });
    assert.deepEqual([...b.docs], [DOCS.bTagged.docId]);
  });

  test('a value outside the tenant vocabulary is unknown_scope_value (400), even when another tenant has it', async () => {
    const scope = await scopeOf(TWO_TENANT_IDS.userB);
    const error = await scopesModule.resolveScopesFilter({ scopes: ['region:b2'] }, { scope }).catch((caught: unknown) => caught);
    assert.ok(error instanceof scopesModule.ScopeFilterError);
    assert.equal(error.code, 'unknown_scope_value');
    assert.equal(error.status, 400);
  });

  test('with RAG_SCOPE_TAGS false a scopes filter is scopes_disabled (400)', async () => {
    process.env.RAG_SCOPE_TAGS = 'false';
    try {
      const scope = await scopeOf(TWO_TENANT_IDS.userA);
      const error = await scopesModule.resolveScopesFilter({ scopes: ['region:a1'] }, { scope }).catch((caught: unknown) => caught);
      assert.ok(error instanceof scopesModule.ScopeFilterError);
      assert.equal(error.code, 'scopes_disabled');
      assert.equal(error.status, 400);
    } finally {
      process.env.RAG_SCOPE_TAGS = 'true';
    }
  });
});
