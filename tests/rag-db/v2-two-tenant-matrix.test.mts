import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import {
  V2_CANARY_QUERY,
  V2_CONTRACT_QUESTION,
  V2_EXACT_CODE,
  V2_EXACT_QUERY,
  V2_LEGACY_EMBEDDING_PROFILE,
  V2_TRANSLATED_QUESTION,
  V2_TRANSLATED_TEXT,
  createTwoTenantV2Database,
  foreignMarkers,
  type TwoTenantV2Database,
  type TwoTenantV2Tenant,
  type V2TenantLabel,
} from '../../eval/harness/two-tenant-v2.mts';
import { hit } from '../rag/fusion/helpers.ts';

type Profile = 'chat' | 'embed' | 'voice' | 'eval';
type Path = 'all' | 'exact_id' | 'translated';
type RetrievalResult = import('@/lib/rag').RetrievalResult;
type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;

const PROFILES: Profile[] = ['chat', 'embed', 'voice', 'eval'];
const LABELS: V2TenantLabel[] = ['a', 'b', 'o'];
const PATHS: Path[] = ['all', 'exact_id', 'translated'];
const QUERY_OF: Record<Path, string> = { all: V2_EXACT_QUERY, exact_id: `${V2_EXACT_CODE} catalogue item`, translated: V2_TRANSLATED_QUESTION };
const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const D01_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'true',
  RAG_RERANKER: 'auto',
  RAG_REFUSAL_THRESHOLD: 'true',
  RAG_REFUSAL_FLOOR: 'legacy_rule',
};

/** A fixture-corpus question the legacy pipeline answers in the smoke tier (golden item en-compound-001). */
const LEGACY_ANSWERABLE_QUERY = 'What are the refund windows for annual plans and for monthly plans?';
const CI_LANGUAGES: Record<string, string> = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' };

/** Sets (CI values) or removes the two language variables the Phase 3.2 reader takes from process.env. */
async function withLanguages<T>(configured: boolean, body: () => Promise<T>): Promise<T> {
  const settings = await import('@/lib/rag/lang/settings');
  const saved = Object.fromEntries(Object.keys(CI_LANGUAGES).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(CI_LANGUAGES)) {
    if (configured) process.env[name] = value;
    else delete process.env[name];
  }
  settings.resetLanguageSettingsForTests();
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    settings.resetLanguageSettingsForTests();
  }
}

interface RerankBody {
  model: string;
  query: string;
  documents: string[];
}

function lower(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

describe('every v2 retrieval path stays inside the caller tenant, for every entry profile, with every switch on', () => {
  let fixture: TwoTenantV2Database;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let depsModule: typeof import('@/lib/rag/deps');
  let registryModule: typeof import('@/lib/rag/backend/registry');
  let selectModule: typeof import('@/lib/rag/rerank/select');
  let translateModule: typeof import('@/lib/rag/query/translate');
  let configModule: typeof import('@/lib/rag/config');
  let contextModule: typeof import('@/lib/rag/v2/stages/context');
  let collectorModule: typeof import('@/lib/rag/trace/collector');
  let paramsModule: typeof import('@/lib/rag/v2/retrieval-params');
  let allOnEnv: Record<string, string>;
  let adminClient: SupabaseClient;
  const rerankBodies: RerankBody[] = [];
  const previousEnv = { ...process.env } as Record<string, string | undefined>;

  const db = (): PGlite => fixture.db;
  const tenant = (label: V2TenantLabel): TwoTenantV2Tenant => fixture.seed.tenants[label];
  const rpcCalls = () => edge.calls.filter((call) => call.path.includes('/rpc/'));

  before(async () => {
    fixture = await createTwoTenantV2Database();
    edge = await startFakeEdge({ db: fixture.db });
    const processEnv = fixtureProcessEnv(edge.url);
    Object.assign(process.env, processEnv);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.RAG_VOICE_TOKEN_SECRET = VOICE_SECRET;
    rag = await import('@/lib/rag');
    scopeModule = await import('@/lib/rag/tenant/scope');
    depsModule = await import('@/lib/rag/deps');
    registryModule = await import('@/lib/rag/backend/registry');
    selectModule = await import('@/lib/rag/rerank/select');
    translateModule = await import('@/lib/rag/query/translate');
    configModule = await import('@/lib/rag/config');
    contextModule = await import('@/lib/rag/v2/stages/context');
    collectorModule = await import('@/lib/rag/trace/collector');
    paramsModule = await import('@/lib/rag/v2/retrieval-params');
    const { createCohereReranker } = await import('@/lib/rag/rerank/cohere');
    const { createLocalBm25Reranker } = await import('@/lib/rag/rerank/local-bm25');

    adminClient = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    allOnEnv = {
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_RERANKER: 'cohere',
      RAG_RERANK_TIER_CHAT: 'quality',
      RAG_RERANK_TIER_VOICE: 'quality',
      RAG_REFUSAL_THRESHOLD: 'true',
      RAG_CONTEXT_EDGE_ORDER: 'true',
      RAG_CONTEXT_COMPRESSION: 'true',
      RAG_PARENT_CHILD: 'true',
      RAG_LEXICAL_TRANSLATION: 'true',
      RAG_EXACT_ID_LOOKUP: 'true',
      COHERE_API_KEY: processEnv.COHERE_API_KEY as string,
      COHERE_BASE_URL: processEnv.COHERE_BASE_URL as string,
    };
    depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv, adminClient: () => adminClient });
    registryModule.resetRetrievalBackendForTests();
    configModule.resetRagConfigForTests();

    const recordingFetch: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RerankBody;
      rerankBodies.push({ model: body.model, query: body.query, documents: body.documents });
      return fetch(input, init);
    };
    selectModule.setRerankerFactoryForTests((provider, _model, env) =>
      provider === 'local_bm25'
        ? createLocalBm25Reranker()
        : createCohereReranker({ fetch: recordingFetch, apiKey: env.COHERE_API_KEY ?? '', baseUrl: env.COHERE_BASE_URL ?? '', model: 'fake-quality-v1' }),
    );
    translateModule.setTranslatorForTests(
      translateModule.createFixtureTranslator({
        version: 1,
        entries: [{ question: V2_TRANSLATED_QUESTION, translations: [{ language: 'it', text: V2_TRANSLATED_TEXT }] }],
      }),
    );
  });

  after(async () => {
    selectModule?.resetRerankerFactoryForTests();
    translateModule?.resetTranslatorForTests();
    depsModule?.resetRagDepsForTests();
    registryModule?.resetRetrievalBackendForTests();
    configModule?.resetRagConfigForTests();
    await edge?.close();
    await fixture?.db.close();
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
  });

  async function scopeFor(profile: Profile, label: V2TenantLabel): Promise<TenantScope> {
    const t = tenant(label);
    const signal = new AbortController().signal;
    if (profile === 'chat') {
      const { resolveTenantScope } = await import('@/lib/rag/tenant/resolve-chat');
      const resolved = await resolveTenantScope({
        requestedOrganizationId: t.organizationId,
        deploymentMode: 'multi-tenant',
        getUser: async () => ({ id: t.userId }),
        admin: adminClient,
        signal,
      });
      assert.ok(resolved.ok && resolved.scope, `chat scope for ${label}`);
      return resolved.scope;
    }
    if (profile === 'embed') {
      const resolved = await rag.resolveEmbedScope({ rawBody: {}, configuredTenant: t.scopeKey, deploymentMode: 'multi-tenant', admin: adminClient, signal });
      assert.ok(resolved.ok, `embed scope for ${label}`);
      return resolved.scope;
    }
    if (profile === 'voice') {
      const minted = rag.mintVoiceToken({
        scope: scopeModule.mintScope(t.organizationId ? 'org' : 'personal', t.userId, t.organizationId),
        secret: VOICE_SECRET,
        ttlSeconds: 600,
      });
      assert.ok(minted.ok, 'voice token');
      const resolved = await rag.resolveVoiceScope({
        headers: new Headers({ [rag.VOICE_SCOPE_HEADER]: minted.token }),
        deploymentMode: 'multi-tenant',
        secret: VOICE_SECRET,
        admin: adminClient,
        signal,
      });
      assert.ok(resolved.ok, `voice scope for ${label}`);
      return resolved.scope;
    }
    const resolved = rag.evalScope({
      deploymentMode: 'multi-tenant',
      organizationId: t.organizationId,
      userId: t.userId,
      allowedScopes: `user:${t.userId},org:${TWO_TENANT_IDS.orgO}`,
    });
    assert.ok(resolved.ok, `eval scope for ${label}`);
    return resolved.scope;
  }

  async function retrieve(
    scope: TenantScope,
    profile: Profile,
    query: string,
    extra: Partial<import('@/lib/rag').RunRetrievalInput> = {},
  ): Promise<{ result: RetrievalResult; rerank: RerankBody[]; rpcDelta: number }> {
    const rerankBefore = rerankBodies.length;
    const rpcBefore = rpcCalls().length;
    const result = await rag.runRetrieval({ scope, query, profile, options: OPTIONS, signal: new AbortController().signal, ...extra });
    return { result, rerank: rerankBodies.slice(rerankBefore), rpcDelta: rpcCalls().length - rpcBefore };
  }

  function chunkIdsOf(result: RetrievalResult): string[] {
    const ids = new Set<string>();
    for (const row of [...result.candidates, ...result.relevantChunks]) ids.add(row.chunk_id);
    for (const row of result.kept) ids.add(row.chunk_id);
    for (const row of result.voice?.results ?? []) ids.add(row.chunk_id);
    return [...ids];
  }

  function documentIdsOf(result: RetrievalResult): string[] {
    const ids = new Set<string>();
    for (const row of result.candidates) ids.add(row.document_id);
    for (const row of result.usedDocuments) ids.add(row.id);
    for (const row of result.kept) ids.add(row.document_id);
    for (const row of result.voice?.results ?? []) ids.add(row.document_id);
    return [...ids];
  }

  async function tenantKeys(table: 'document_chunks' | 'documents' | 'document_parents', ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db().query<{ id: string; tenant_key: string }>(`SELECT id::text AS id, tenant_key FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    return new Map(rows.rows.map((row) => [row.id, row.tenant_key]));
  }

  async function assertOwnRows(label: V2TenantLabel, result: RetrievalResult, where: string, options: { parents?: boolean } = {}): Promise<void> {
    const own = tenant(label).scopeKey;
    const chunkIds = chunkIdsOf(result);
    const chunkKeys = await tenantKeys('document_chunks', chunkIds);
    for (const id of chunkIds) assert.equal(chunkKeys.get(id), own, `${where}: chunk ${id} belongs to ${chunkKeys.get(id) ?? 'nobody'}`);
    const docIds = documentIdsOf(result);
    const docKeys = await tenantKeys('documents', docIds);
    for (const id of docIds) assert.equal(docKeys.get(id), own, `${where}: document ${id} belongs to ${docKeys.get(id) ?? 'nobody'}`);
    const parentIds = options.parents === false ? [] : result.candidates.map((row) => row.parent_id).filter((id): id is string => typeof id === 'string');
    const parentKeys = await tenantKeys('document_parents', parentIds);
    for (const id of parentIds) assert.equal(parentKeys.get(id), own, `${where}: parent ${id} belongs to ${parentKeys.get(id) ?? 'nobody'}`);
    const imageUrls = [...result.sourceImages.map((image) => image.url), ...(result.voice?.source_images ?? []).map((image) => (image as { url?: string }).url)];
    const urls = imageUrls.filter((url): url is string => typeof url === 'string');
    if (urls.length > 0) {
      const owners = await db().query<{ url: string; tenant_key: string }>(
        `SELECT DISTINCT metadata->>'image_url' AS url, tenant_key FROM document_chunks WHERE metadata->>'image_url' = ANY($1::text[])`,
        [urls],
      );
      for (const url of urls) {
        const keys = owners.rows.filter((row) => row.url === url).map((row) => row.tenant_key);
        assert.deepEqual(keys, [own], `${where}: source image ${url} is owned by ${keys.join(', ') || 'nobody'}, not only the caller`);
      }
    }
  }

  function assertNoForeignText(label: V2TenantLabel, surfaces: Record<string, unknown>, where: string): void {
    for (const marker of foreignMarkers(fixture.seed, label)) {
      for (const [name, value] of Object.entries(surfaces)) {
        assert.ok(!lower(value).includes(marker.toLowerCase()), `${where}: ${name} holds foreign marker ${marker}`);
      }
    }
  }

  function stage(result: RetrievalResult, name: string) {
    return result.stages.find((record) => record.name === name);
  }

  for (const profile of PROFILES) {
    for (const label of LABELS) {
      for (const path of PATHS) {
        test(`${profile} scope ${label}, path ${path}: only the caller's chunks, parents, sources, images and rerank input`, async () => {
          const where = `${profile}/${label}/${path}`;
          const t = tenant(label);
          const scope = await scopeFor(profile, label);
          assert.equal(scopeModule.scopeKey(scope), t.scopeKey);
          const { result, rerank } = await retrieve(scope, profile, QUERY_OF[path]);

          assert.ok(['ok', 'degraded'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
          await assertOwnRows(label, result, where);
          assertNoForeignText(label, { result, stages: result.stages, rerankRequests: rerank }, where);

          const ids = chunkIdsOf(result);
          assert.ok(ids.length > 0, `${where}: the caller's own chunks come back`);
          if (path === 'all') {
            const text = profile === 'voice' ? lower(result.voice) : result.context.toLowerCase();
            assert.ok(text.includes(t.markers.child.toLowerCase()) || text.includes(t.markers.parent.toLowerCase()), `${where}: own canary text present`);
          }
          if (path === 'exact_id') {
            const record = stage(result, 'exact_id_lookup');
            assert.equal(record?.status, 'ok', `${where}: exact id lookup ran`);
            assert.equal(record?.candidates_out, 1, `${where}: the code exists in all three tenants and the lookup returns one row`);
            assert.ok(chunkIdsOf(result).includes(t.exactChunkId), `${where}: own exact chunk comes back`);
          }
          if (path === 'translated') {
            assert.equal(stage(result, 'translate')?.status, 'ok', `${where}: translate ran`);
            assert.ok(chunkIdsOf(result).includes(t.translatedChunkId), `${where}: own Italian chunk comes back`);
            const translated = result.candidates.find((row) => row.chunk_id === t.translatedChunkId);
            if (profile !== 'voice') {
              assert.ok(translated, `${where}: own Italian chunk is a candidate`);
              assert.ok(Object.keys(translated.legs ?? {}).includes('lexical:1'), `${where}: found by the translated lexical leg`);
            }
          }
          assert.ok(rerank.length >= 1, `${where}: the rerank endpoint was called`);
          for (const body of rerank) {
            const surfaces = { query: body.query, documents: body.documents };
            assertNoForeignText(label, surfaces, `${where} rerank input`);
          }
        });
      }
    }
  }

  test('the rerank endpoint received the caller text only: each request carries one tenant marker set', async () => {
    const scope = await scopeFor('chat', 'a');
    const { rerank } = await retrieve(scope, 'chat', V2_EXACT_QUERY);
    assert.ok(rerank.length >= 1);
    const joined = rerank.map((body) => body.documents.join('\n')).join('\n').toLowerCase();
    assert.ok(joined.includes(tenant('a').markers.child.toLowerCase()) || joined.includes(tenant('a').markers.parent.toLowerCase()));
    assert.ok(edge.calls.some((call) => call.path === '/v2/rerank'));
  });

  test('a parent id of another tenant on the caller own child is ignored by expand_parents', async () => {
    const a = tenant('a');
    const b = tenant('b');
    const forgedChild = a.childChunkIds[0] as string;
    const original = (await db().query<{ parent_id: string }>('SELECT parent_id::text AS parent_id FROM document_chunks WHERE id = $1', [forgedChild])).rows[0]
      ?.parent_id as string;
    await db().query('UPDATE document_chunks SET parent_id = $1 WHERE id = $2', [b.parentIds[0], forgedChild]);
    try {
      const scope = await scopeFor('chat', 'a');
      const { result } = await retrieve(scope, 'chat', V2_CANARY_QUERY);
      assertNoForeignText('a', { context: result.context, candidates: result.candidates, kept: result.kept, sources: result.usedDocuments }, 'forged parent');
      await assertOwnRows('a', result, 'forged parent', { parents: false });
      assert.equal(stage(result, 'expand_parents')?.status, 'ok', 'expand_parents ran');
      assert.ok(result.context.includes(a.markers.child), 'own text still comes back');
    } finally {
      await db().query('UPDATE document_chunks SET parent_id = $1 WHERE id = $2', [original, forgedChild]);
    }
  });

  test('expand_parents stage with a forged foreign parent id in the survivor list returns no foreign content', async () => {
    const a = tenant('a');
    const b = tenant('b');
    const scope = await scopeFor('chat', 'a');
    configModule.resetRagConfigForTests();
    const config = configModule.loadRagConfig(allOnEnv);
    const collector = collectorModule.createTraceCollector({ profile: 'chat', tenantKey: a.scopeKey });
    const params = { ...paramsModule.effectiveRetrievalParams('chat', config, null), final_top_k: 20 };
    const survivors = [
      { chunkId: a.childChunkIds[0] as string, documentId: a.canaryDocumentId, parentId: a.parentIds[0] as string, name: 'v2-canary-a' },
      { chunkId: 'forged-1', documentId: a.canaryDocumentId, parentId: b.parentIds[0] as string, name: 'v2-canary-a' },
      { chunkId: 'forged-2', documentId: b.canaryDocumentId, parentId: b.parentIds[0] as string, name: 'v2-canary-b' },
    ].map((row, index) => ({
      hit: hit(row.chunkId, {
        rank: index + 1,
        documentId: row.documentId,
        parentId: row.parentId,
        chunkIndex: index,
        content: `child body of ${row.chunkId}`,
        similarity: 0.9 - index * 0.01,
        document: { filename: `${row.name}.md`, createdAt: null, metadata: {}, contentPreview: '' },
      }),
      score: 1 / (60 + index + 1),
      ranks: { 'dense:0': index + 1 },
    }));
    const out = await contextModule.runContextStages({
      input: { scope, query: V2_CANARY_QUERY, profile: 'chat', signal: new AbortController().signal },
      config,
      profile: 'chat',
      params,
      fusedHits: survivors,
      referenced: null,
      signal: new AbortController().signal,
      collector,
    });
    const context = out.assembly?.context ?? '';
    assert.ok(context.includes(a.markers.parent), 'own parent is used');
    assert.ok(!context.toLowerCase().includes(b.markers.parent.toLowerCase()), 'foreign parent content must not appear');
    assert.ok(!context.toLowerCase().includes(b.markers.child.toLowerCase()), 'foreign child content must not appear');
  });

  test('a document id of another tenant in retrievalFilters returns no rows', async () => {
    const scope = await scopeFor('chat', 'a');
    const { result } = await retrieve(scope, 'chat', V2_EXACT_QUERY, { retrievalFilters: { documentIds: [tenant('b').canaryDocumentId, tenant('b').exactDocumentId] } });
    assert.equal(chunkIdsOf(result).length, 0);
    assert.equal(result.usedDocuments.length, 0);
    assertNoForeignText('a', { result }, 'foreign document filter');
    assert.ok(!result.context.includes(tenant('a').markers.exact), 'the caller own exact document is outside the filter and stays out');
  });

  test('a referenced own document and a filter naming only another tenant document do not widen to the whole tenant', async () => {
    const a = tenant('a');
    const scope = await scopeFor('chat', 'a');
    const { result } = await retrieve(scope, 'chat', V2_EXACT_QUERY, {
      documentRefs: { mentions: [], documentParts: [{ id: a.exactDocumentId, name: 'v2-exact-a.md' }] },
      retrievalFilters: { documentIds: [tenant('b').canaryDocumentId] },
    });
    assertNoForeignText('a', { result }, 'disjoint filter and reference');
    assert.deepEqual(
      [...new Set(chunkIdsOf(result))].filter((id) => id !== a.exactChunkId),
      [],
      'a request narrowed to nothing returns nothing beyond the referenced document the filter excludes',
    );
  });

  test('a filter widening to a document id of the caller and of another tenant keeps only the caller rows', async () => {
    const scope = await scopeFor('chat', 'a');
    const filter = { documentIds: [tenant('a').exactDocumentId, tenant('b').exactDocumentId, tenant('o').exactDocumentId] };
    const { result } = await retrieve(scope, 'chat', V2_EXACT_QUERY, { retrievalFilters: filter });
    await assertOwnRows('a', result, 'mixed document filter');
    const docs = new Set(documentIdsOf(result));
    assert.deepEqual([...docs], [tenant('a').exactDocumentId]);
  });

  test('a doc type only another tenant has returns no rows, and the owner still finds it', async () => {
    const { typeOnly } = fixture.seed;
    const question = V2_CONTRACT_QUESTION;
    const asA = await retrieve(await scopeFor('chat', 'a'), 'chat', question, { retrievalFilters: { docTypes: [typeOnly.docType] } });
    assert.equal(chunkIdsOf(asA.result).length, 0);
    assertNoForeignText('a', { result: asA.result }, 'foreign doc type filter');
    const asO = await retrieve(await scopeFor('chat', 'o'), 'chat', question, { retrievalFilters: { docTypes: [typeOnly.docType] } });
    assert.equal(chunkIdsOf(asO.result).length, 0);
    const asB = await retrieve(await scopeFor('chat', 'b'), 'chat', question, { retrievalFilters: { docTypes: [typeOnly.docType] } });
    assert.deepEqual(chunkIdsOf(asB.result), [typeOnly.chunkId]);
  });

  test('every v2 entry point refuses a tenant key of another deployment mode and a malformed key in SQL', async () => {
    const vector = `[${embedText(V2_CANARY_QUERY).join(',')}]`;
    const call = async (tenantKey: string): Promise<string | null> => {
      try {
        await db().query(
          `SELECT * FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => ARRAY['canary'], p_dense_limit => 5, p_lexical_limit => 5)`,
          [tenantKey, V2_LEGACY_EMBEDDING_PROFILE, vector],
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    assert.match((await call('s:default')) ?? 'accepted', /not valid for this deployment mode/);
    assert.match((await call(`u:${TWO_TENANT_IDS.userA.toUpperCase()}`)) ?? 'accepted', /malformed tenant key/);
    assert.match((await call('')) ?? 'accepted', /malformed tenant key/);
    assert.equal(await call(`u:${TWO_TENANT_IDS.userA}`), null);
  });

  test('a scope minted with upper-case UUIDs retrieves exactly what its lower-case form retrieves', async () => {
    const lowerScope = scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null);
    const upperScope = scopeModule.mintScope('personal', TWO_TENANT_IDS.userA.toUpperCase(), null);
    assert.equal(scopeModule.scopeKey(upperScope), scopeModule.scopeKey(lowerScope));
    const lowerRun = await retrieve(lowerScope, 'chat', V2_EXACT_QUERY);
    const upperRun = await retrieve(upperScope, 'chat', V2_EXACT_QUERY);
    assert.ok(chunkIdsOf(lowerRun.result).length > 0);
    assert.deepEqual(chunkIdsOf(upperRun.result).sort(), chunkIdsOf(lowerRun.result).sort());
    assert.equal(upperRun.result.context, lowerRun.result.context);

    const orgLower = scopeModule.mintScope('org', TWO_TENANT_IDS.userA, TWO_TENANT_IDS.orgO);
    const orgUpper = scopeModule.mintScope('org', TWO_TENANT_IDS.userA.toUpperCase(), TWO_TENANT_IDS.orgO.toUpperCase());
    assert.equal(scopeModule.scopeKey(orgUpper), scopeModule.scopeKey(orgLower));
    const orgLowerRun = await retrieve(orgLower, 'eval', V2_EXACT_QUERY);
    const orgUpperRun = await retrieve(orgUpper, 'eval', V2_EXACT_QUERY);
    assert.deepEqual(chunkIdsOf(orgUpperRun.result).sort(), chunkIdsOf(orgLowerRun.result).sort());

    const evalUpper = rag.evalScope({
      deploymentMode: 'multi-tenant',
      organizationId: TWO_TENANT_IDS.orgO.toUpperCase(),
      userId: null,
      allowedScopes: `org:${TWO_TENANT_IDS.orgO}`,
    });
    assert.ok(evalUpper.ok);
    assert.equal(scopeModule.scopeKey(evalUpper.scope), `o:${TWO_TENANT_IDS.orgO}`);
    const evalRun = await retrieve(evalUpper.scope, 'eval', V2_EXACT_QUERY);
    assert.deepEqual(chunkIdsOf(evalRun.result).sort(), chunkIdsOf(orgLowerRun.result).sort());
  });

  test('a missing admin client gives status error with reason backend_error: no anon fallback, no RPC, no empty answer', async () => {
    depsModule.setRagDepsForTests({ adminClient: () => null });
    registryModule.resetRetrievalBackendForTests();
    try {
      for (const profile of PROFILES) {
        const scope = await scopeFor(profile, 'a').catch(() => null);
        const resolved = scope ?? scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null);
        const { result, rpcDelta } = await retrieve(resolved, profile, V2_EXACT_QUERY);
        assert.equal(result.status, 'error', `${profile}: status`);
        assert.equal(result.reason, 'backend_error', `${profile}: reason`);
        assert.equal(rpcDelta, 0, `${profile}: no RPC reached the database through another client`);
        assert.equal(result.candidates.length, 0);
        assert.equal(result.context, '');
      }
    } finally {
      depsModule.setRagDepsForTests({ adminClient: () => adminClient });
      registryModule.resetRetrievalBackendForTests();
    }
  });

  test('no scope retrieves nothing and issues no RPC', async () => {
    const calls = rpcCalls().length;
    const { result } = await retrieve(null as unknown as TenantScope, 'chat', V2_EXACT_QUERY);
    assert.equal(result.status, 'empty');
    assert.equal(result.reason, 'no_tenant');
    assert.equal(rpcCalls().length, calls);
  });

  test('two-tenant matrix under the D-01 values: multi-tenant, keyless and with the fixture key, every profile and tenant stays inside the caller tenant', async () => {
    const fixtureKey = process.env.COHERE_API_KEY as string;
    const variants = [
      { name: 'keyless', env: { ...D01_ENV, COHERE_API_KEY: '' }, hosted: false },
      { name: 'fixture key', env: { ...D01_ENV, COHERE_API_KEY: fixtureKey, COHERE_BASE_URL: process.env.COHERE_BASE_URL as string }, hosted: true },
    ];
    assert.ok(fixtureKey, 'the fake edge supplies a placeholder Cohere key');
    try {
      for (const variant of variants) {
        depsModule.setRagDepsForTests({ ragEnv: () => variant.env });
        configModule.resetRagConfigForTests();
        for (const profile of PROFILES) {
          for (const label of LABELS) {
            const where = `D-01 ${variant.name} ${profile}/${label}`;
            const t = tenant(label);
            const scope = await scopeFor(profile, label);
            assert.equal(scopeModule.scopeKey(scope), t.scopeKey);
            const { result, rerank } = await retrieve(scope, profile, V2_EXACT_QUERY);

            assert.ok(['ok', 'empty'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
            assert.ok(rpcCalls().some((call) => call.path.endsWith('/rpc/hybrid_search_chunks')), `${where}: served by v2`);
            assert.ok(result.candidates.length > 0 || (result.voice?.results ?? []).length > 0, `${where}: the caller's own candidates come back`);
            await assertOwnRows(label, result, where);
            assertNoForeignText(label, { result, stages: result.stages, rerankRequests: rerank }, where);
            const rerankStage = stage(result, 'rerank');
            if (variant.hosted) {
              assert.ok(rerank.length >= 1, `${where}: auto with a Cohere key reranks on the edge`);
              for (const body of rerank) assertNoForeignText(label, { query: body.query, documents: body.documents }, `${where} rerank input`);
            } else {
              assert.equal(rerank.length, 0, `${where}: no key, no rerank request`);
              assert.equal(rerankStage?.detail, 'auto:local_bm25', `${where}: keyless auto takes the no-key fallback`);
              assert.notEqual(rerankStage?.status, 'degraded', `${where}: keyless auto is not degraded`);
            }
          }
        }
      }
    } finally {
      depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv });
      configModule.resetRagConfigForTests();
    }
  });

  test('two-tenant matrix under the implicit defaults: multi-tenant, nothing set, with and without the CI languages, every profile serves legacy inside the caller tenant', async () => {
    const hybrid = () => rpcCalls().filter((call) => call.path.endsWith('/rpc/hybrid_search_chunks')).length;
    let ownCandidates = 0;
    try {
      for (const languages of [true, false]) {
        await withLanguages(languages, async () => {
          for (const profile of PROFILES) {
            for (const label of LABELS) {
              const where = `implicit defaults, languages ${languages ? 'set' : 'unset'}, ${profile}/${label}`;
              const scope = await scopeFor(profile, label);
              depsModule.setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'legacy' }) });
              configModule.resetRagConfigForTests();
              const { result: expected } = await retrieve(scope, profile, V2_EXACT_QUERY);
              depsModule.setRagDepsForTests({ ragEnv: () => ({}) });
              configModule.resetRagConfigForTests();
              const before = hybrid();
              const { result, rerank } = await retrieve(scope, profile, V2_EXACT_QUERY);
              assert.ok(['ok', 'empty'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
              assert.equal(hybrid(), before, `${where}: the shipped default is legacy, hybrid_search_chunks is not called`);
              assert.equal(rerank.length, 0, `${where}: no rerank request`);
              assert.deepEqual(
                { status: result.status, reason: result.reason, chunks: chunkIdsOf(result).sort(), documents: documentIdsOf(result).sort() },
                { status: expected.status, reason: expected.reason, chunks: chunkIdsOf(expected).sort(), documents: documentIdsOf(expected).sort() },
                `${where}: equals explicit legacy for the same scope`,
              );
              await assertOwnRows(label, result, where, { parents: false });
              assertNoForeignText(label, { result, stages: result.stages }, where);
              ownCandidates += chunkIdsOf(result).length;
            }
          }
        });
      }
      assert.ok(ownCandidates > 0, 'the legacy default returned the callers their own chunks');
    } finally {
      depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv });
      configModule.resetRagConfigForTests();
    }
  });

  test('the fixture edge saw no unsupported request', () => {
    assert.deepEqual(edge.errors, []);
  });
});

describe('single-tenant deployment accepts only the default tenant key', () => {
  let fixture: FixtureDatabase;
  let edge: FakeEdge;
  let client: SupabaseClient;
  let rag: typeof import('@/lib/rag');
  let scopeModule: typeof import('@/lib/rag/tenant/scope');
  let depsModule: typeof import('@/lib/rag/deps');
  let registryModule: typeof import('@/lib/rag/backend/registry');
  let configModule: typeof import('@/lib/rag/config');
  const previousEnv = { ...process.env } as Record<string, string | undefined>;

  before(async () => {
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: path.join(repoRoot, 'eval/fixtures/corpus') });
    edge = await startFakeEdge({ db: fixture.db });
    const processEnv = fixtureProcessEnv(edge.url);
    Object.assign(process.env, processEnv);
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    rag = await import('@/lib/rag');
    scopeModule = await import('@/lib/rag/tenant/scope');
    depsModule = await import('@/lib/rag/deps');
    registryModule = await import('@/lib/rag/backend/registry');
    configModule = await import('@/lib/rag/config');
    client = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
    depsModule.setRagDepsForTests({
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }),
      adminClient: () => client,
      embedder: async (text) => embedText(text),
    });
    registryModule.resetRetrievalBackendForTests();
    configModule.resetRagConfigForTests();
  });

  after(async () => {
    depsModule?.resetRagDepsForTests();
    registryModule?.resetRetrievalBackendForTests();
    configModule?.resetRagConfigForTests();
    await edge?.close();
    await fixture?.db.close();
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
  });

  const run = (scope: TenantScope, query = 'what is the refund policy') =>
    rag.runRetrieval({ scope, query, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });

  test('the single scope retrieves, a personal and an organization key raise and surface as backend_error', async () => {
    const single = await run(scopeModule.mintScope('single', null, null));
    assert.ok(['ok', 'degraded', 'empty'].includes(single.status), `single scope status ${single.status}`);
    assert.notEqual(single.reason, 'backend_error');
    assert.ok(single.candidates.length > 0, 'the default tenant has its corpus');

    for (const scope of [scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null), scopeModule.mintScope('org', null, TWO_TENANT_IDS.orgO)]) {
      const refused = await run(scope);
      assert.equal(refused.status, 'error');
      assert.equal(refused.reason, 'backend_error');
      assert.equal(refused.candidates.length, 0);
    }
  });

  test('two-tenant matrix under the D-01 values: single-tenant, keyless and with the fixture key, only the default tenant key retrieves', async () => {
    const variants = [
      { ...D01_ENV, COHERE_API_KEY: '' },
      { ...D01_ENV, COHERE_API_KEY: process.env.COHERE_API_KEY as string, COHERE_BASE_URL: process.env.COHERE_BASE_URL as string },
    ];
    const selectModule = await import('@/lib/rag/rerank/select');
    const { createCohereReranker } = await import('@/lib/rag/rerank/cohere');
    const { createLocalBm25Reranker } = await import('@/lib/rag/rerank/local-bm25');
    selectModule.setRerankerFactoryForTests((provider, _model, env, fetchImpl) =>
      provider === 'local_bm25'
        ? createLocalBm25Reranker()
        : createCohereReranker({ fetch: fetchImpl, apiKey: env.COHERE_API_KEY ?? '', baseUrl: env.COHERE_BASE_URL ?? '', model: 'fake-quality-v1' }),
    );
    try {
      for (const env of variants) {
        depsModule.setRagDepsForTests({ ragEnv: () => env });
        configModule.resetRagConfigForTests();
        const where = `D-01 single-tenant ${env.COHERE_API_KEY ? 'fixture key' : 'keyless'}`;
        const single = await run(scopeModule.mintScope('single', null, null));
        assert.ok(['ok', 'empty'].includes(single.status), `${where}: single scope status ${single.status} (${single.reason})`);
        assert.ok(single.candidates.length > 0, `${where}: the default tenant has its corpus`);
        const rerankStage = single.stages.find((record) => record.name === 'rerank');
        assert.equal(rerankStage?.status, 'ok', `${where}: rerank ran`);
        assert.equal(rerankStage?.detail, env.COHERE_API_KEY ? 'auto:cohere' : 'auto:local_bm25', `${where}: auto resolved by key presence`);
        const keys = await fixture.db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [
          single.candidates.map((row) => row.chunk_id),
        ]);
        assert.deepEqual(keys.rows.map((row) => row.tenant_key), ['s:default'], `${where}: every candidate is a default-tenant chunk`);
        for (const scope of [scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null), scopeModule.mintScope('org', null, TWO_TENANT_IDS.orgO)]) {
          const refused = await run(scope);
          assert.equal(refused.status, 'error', `${where}: a multi-tenant key is refused`);
          assert.equal(refused.reason, 'backend_error');
          assert.equal(refused.candidates.length, 0);
        }
      }
    } finally {
      selectModule.resetRerankerFactoryForTests();
      depsModule.setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
      configModule.resetRagConfigForTests();
    }
  });

  test('two-tenant matrix under the implicit defaults: single-tenant, nothing set, with and without the CI languages, the default tenant gets legacy and only its own chunks', async () => {
    const hybrid = () => edge.calls.filter((call) => call.path.endsWith('/rpc/hybrid_search_chunks')).length;
    const scopes = [
      scopeModule.mintScope('single', null, null),
      scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null),
      scopeModule.mintScope('org', null, TWO_TENANT_IDS.orgO),
    ];
    try {
      for (const languages of [true, false]) {
        await withLanguages(languages, async () => {
          for (const scope of scopes) {
            const where = `implicit defaults single-tenant, languages ${languages ? 'set' : 'unset'}, ${scopeModule.scopeKey(scope)}`;
            depsModule.setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'legacy' }) });
            configModule.resetRagConfigForTests();
            const expected = await run(scope, LEGACY_ANSWERABLE_QUERY);
            depsModule.setRagDepsForTests({ ragEnv: () => ({}) });
            configModule.resetRagConfigForTests();
            const before = hybrid();
            const result = await run(scope, LEGACY_ANSWERABLE_QUERY);
            assert.equal(hybrid(), before, `${where}: hybrid_search_chunks is not called`);
            assert.deepEqual(
              { status: result.status, reason: result.reason, chunks: result.candidates.map((row) => row.chunk_id) },
              { status: expected.status, reason: expected.reason, chunks: expected.candidates.map((row) => row.chunk_id) },
              `${where}: equals explicit legacy`,
            );
            if (result.candidates.length > 0) {
              const keys = await fixture.db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [
                result.candidates.map((row) => row.chunk_id),
              ]);
              assert.deepEqual(keys.rows.map((row) => row.tenant_key), ['s:default'], `${where}: only default-tenant chunks`);
            }
            if (scope.kind === 'single') assert.ok(result.candidates.length > 0, `${where}: the default tenant has its corpus`);
          }
        });
      }
    } finally {
      depsModule.setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
      configModule.resetRagConfigForTests();
    }
  });

  test('hybrid_search_chunks raises for u: and o: keys and accepts s:default', async () => {
    const vector = `[${embedText('refund policy').join(',')}]`;
    const call = async (tenantKey: string): Promise<string | null> => {
      try {
        await fixture.db.query(
          `SELECT * FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => ARRAY['refund'], p_dense_limit => 5, p_lexical_limit => 5)`,
          [tenantKey, V2_LEGACY_EMBEDDING_PROFILE, vector],
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    assert.equal(await call('s:default'), null);
    assert.match((await call(`u:${TWO_TENANT_IDS.userA}`)) ?? 'accepted', /not valid for this deployment mode/);
    assert.match((await call(`o:${TWO_TENANT_IDS.orgO}`)) ?? 'accepted', /not valid for this deployment mode/);
  });
});
