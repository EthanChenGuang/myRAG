import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase, createFixtureDatabase, runFixtureRelex, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import {
  V2_CANARY_QUERY,
  V2_CONTRACT_QUESTION,
  V2_DUP_COPIES,
  V2_DUP_QUERY,
  V2_EXACT_CODE,
  V2_EXACT_QUERY,
  V2_LEGACY_EMBEDDING_PROFILE,
  V2_TRANSLATED_QUESTION,
  V2_TRANSLATED_TEXT,
  clusterLookupCopies,
  createTwoTenantV2Database,
  foreignMarkers,
  seedTwoTenantV2Lookups,
  identifierQuery,
  seedLookupRows,
  singleTenantLookupOwner,
  tableQuery,
  versionQuery,
  type V2LookupOwner,
  type TwoTenantV2Database,
  type TwoTenantV2Tenant,
  type V2TenantLabel,
  Q62_EXAMPLE_TEXT,
  Q62_FOREIGN_DOC_TYPE,
  Q62_GLOSSARY_SOURCE,
  Q62_GLOSSARY_TARGET,
  Q62_OWN_DOC_TYPE,
  Q62_QUESTION,
  Q62_SUB_OWN,
  Q62_TOKEN,
  q62ChunkText,
  q62DecomposeTable,
  q62Scope,
  q62ServiceRoleRpc,
  seedQ62CanaryRows,
  type Q62Mode,
  type Q62Seed,
  type Q62Tenant,
} from '../../eval/harness/two-tenant-v2.mts';
import {
  SENDER_A as WA_SENDER_A,
  SENDER_B as WA_SENDER_B,
  SESSION_A as WA_SESSION_A,
  SESSION_B as WA_SESSION_B,
  createWhatsAppHarness,
  inboundText,
  seedConversation,
  settleTitles,
} from '../whatsapp/harness.ts';
import { hit } from '../rag/fusion/helpers.ts';
import type { FakeQueryLlm } from '../../eval/harness/fake-query-llm.mts';
import type { FakeLangChainChatModel } from '@/lib/rag/query/langchain/fake';

type Profile = 'chat' | 'embed' | 'voice' | 'eval';
type Path = 'all' | 'exact_id' | 'translated' | 'table_lookup' | 'identifier' | 'versions' | 'dup_cluster';
/** The Phase 4.2 paths: each turns on only its own switches (and their prerequisites) on top of the all-on environment. */
type LookupPath = Extract<Path, 'table_lookup' | 'identifier' | 'versions' | 'dup_cluster'>;
type RetrievalResult = import('@/lib/rag').RetrievalResult;
type TenantScope = import('@/lib/rag/tenant/scope').TenantScope;

const PROFILES: Profile[] = ['chat', 'embed', 'voice', 'eval'];
const LABELS: V2TenantLabel[] = ['a', 'b', 'o'];
const LOOKUP_PATHS: LookupPath[] = ['table_lookup', 'identifier', 'versions', 'dup_cluster'];
const PATHS: Path[] = ['all', 'exact_id', 'translated', ...LOOKUP_PATHS];
/** The question of a path asked by (or with the markers of) the given tenant. */
const QUERY_OF: Record<Path, (tenant: TwoTenantV2Tenant) => string> = {
  all: () => V2_EXACT_QUERY,
  exact_id: () => `${V2_EXACT_CODE} catalogue item`,
  translated: () => V2_TRANSLATED_QUESTION,
  table_lookup: (tenant) => tableQuery(tenant.markers),
  identifier: (tenant) => identifierQuery(tenant.markers),
  versions: (tenant) => versionQuery(tenant.markers),
  dup_cluster: () => V2_DUP_QUERY,
};
const PATH_ENV: Record<Path, Record<string, string>> = {
  all: {},
  exact_id: {},
  translated: {},
  table_lookup: { RAG_TABLE_LOOKUP: 'true' },
  identifier: { RAG_IDENTIFIER_INDEX: 'true', RAG_IDENTIFIER_FILTER: 'true' },
  versions: { RAG_VERSION_SCOPE: 'true', RAG_EMBED_VERSION_SCOPE: 'true' },
  dup_cluster: { RAG_DUP_CLUSTERS: 'true', RAG_RESULT_DIVERSITY: 'collapse' },
};
/** Phase 4.4 (LEX-02): every scenario runs once under the default lexical scoring and once with the BM25 leg serving it. */
type Scoring = 'ts_rank_cd' | 'bm25';
const SCORINGS: Scoring[] = ['ts_rank_cd', 'bm25'];
const SCORING_ENV: Record<Scoring, Record<string, string>> = { ts_rank_cd: {}, bm25: { RAG_LEXICAL_SCORING: 'bm25' } };
const BM25_RPC = '/rest/v1/rpc/rag_bm25_search_chunks';
const BM25_FALLBACK_CODES = /lexical_stats_unavailable|lexical_bm25_failed/;

/** Runs one statement as service_role, as the app and the rag:lexstats command do. */
async function asServiceRole<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    return (await tx.query<T>(sql, params)).rows;
  })) as T[];
}

/** Enables and rebuilds the lexical statistics of each tenant key, so the BM25 leg serves it (status ready). */
async function enableLexicalStats(db: PGlite, tenantKeys: readonly string[]): Promise<void> {
  for (const key of tenantKeys) {
    await asServiceRole(db, 'SELECT public.rag_lexstats_enable($1)', [key]);
    await asServiceRole(db, 'SELECT public.rag_lexstats_rebuild($1)', [key]);
  }
}

/** Under bm25: the request called the BM25 function and no lexical call fell back to ts_rank_cd. */
function assertBm25Served(scoring: Scoring, calls: readonly { path: string }[], result: RetrievalResult, where: string): void {
  if (scoring !== 'bm25') {
    assert.ok(!calls.some((call) => call.path === BM25_RPC), `${where}: ts_rank_cd makes no BM25 call`);
    return;
  }
  assert.ok(calls.some((call) => call.path === BM25_RPC), `${where}: the BM25 leg was called`);
  for (const record of result.stages) assert.doesNotMatch(record.detail ?? '', BM25_FALLBACK_CODES, `${where}: stage ${record.name} fell back (${record.detail})`);
}

const PATH_FILTERS: Partial<Record<Path, import('@/lib/rag').RunRetrievalInput['retrievalFilters']>> = { versions: { versionScope: 'all' } };
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

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
/**
 * Every Phase 4.2 service-role function that takes a tenant key (migrations 0852 to 0862), called with valid other arguments so the only
 * reason to raise is the key. Write functions name no existing row and run inside a rolled-back transaction.
 */
const TENANT_KEY_FUNCTIONS: Array<{ fn: string; sql: string; args?: unknown[]; /** The error a key of the right mode meets next, if any. */ ownError?: RegExp }> = [
  { fn: 'rag_purge_hook_table_rows', sql: 'SELECT public.rag_purge_hook_table_rows($1, $2::uuid, ARRAY[]::uuid[])', args: [ZERO_UUID] },
  { fn: 'rag_purge_hook_dup_clusters', sql: 'SELECT public.rag_purge_hook_dup_clusters($1, $2::uuid, ARRAY[]::uuid[])', args: [ZERO_UUID] },
  { fn: 'rag_purge_hook_identifiers', sql: 'SELECT public.rag_purge_hook_identifiers($1, $2::uuid, ARRAY[]::uuid[])', args: [ZERO_UUID] },
  { fn: 'rag_document_versions', sql: 'SELECT * FROM public.rag_document_versions($1, ARRAY[]::uuid[])' },
  {
    fn: 'rag_exact_id_documents',
    sql: `SELECT * FROM public.rag_exact_id_documents($1, ARRAY['qx41071'], 5, NULL, NULL)`,
  },
  { fn: 'rag_dup_write_hashes', sql: `SELECT * FROM public.rag_dup_write_hashes($1, '[]'::jsonb)` },
  { fn: 'rag_dup_candidates', sql: 'SELECT * FROM public.rag_dup_candidates($1, ARRAY[]::uuid[], 16, 0.95, 10)' },
  { fn: 'rag_dup_clusters_recompute', sql: 'SELECT * FROM public.rag_dup_clusters_recompute($1, ARRAY[]::uuid[])' },
  { fn: 'rag_dup_assign', sql: 'SELECT * FROM public.rag_dup_assign($1, ARRAY[]::uuid[], NULL)' },
  { fn: 'rag_dup_backfill_candidates', sql: 'SELECT * FROM public.rag_dup_backfill_candidates($1, NULL, 10, NULL, NULL)' },
  { fn: 'rag_purge_hook_dup_chunk_bands', sql: 'SELECT public.rag_purge_hook_dup_chunk_bands($1, $2::uuid, ARRAY[]::uuid[])', args: [ZERO_UUID] },
  { fn: 'rag_identifier_patterns_list', sql: 'SELECT * FROM public.rag_identifier_patterns_list($1)' },
  {
    fn: 'rag_identifier_pattern_create',
    sql: `SELECT * FROM public.rag_identifier_pattern_create($1, 'neutral-shape', '[A-Z]{2}-[0-9]{5}', 'u', true, NULL)`,
  },
  {
    fn: 'rag_identifier_pattern_update',
    sql: `SELECT * FROM public.rag_identifier_pattern_update($1, $2::uuid, 'neutral-shape', '[A-Z]{2}-[0-9]{5}', 'u', true)`,
    args: [ZERO_UUID],
    ownError: /^pattern_not_found$/,
  },
  { fn: 'rag_identifier_pattern_delete', sql: 'SELECT * FROM public.rag_identifier_pattern_delete($1, $2::uuid)', args: [ZERO_UUID], ownError: /^pattern_not_found$/ },
  { fn: 'rag_identifier_resolve', sql: `SELECT * FROM public.rag_identifier_resolve($1, ARRAY['qx41071'])` },
  { fn: 'rag_identifier_candidates', sql: `SELECT * FROM public.rag_identifier_candidates($1, 'qx41071', 3)` },
  { fn: 'rag_relex_candidates_stamped', sql: `SELECT * FROM public.rag_relex_candidates_stamped(NULL, 1, 10, $1, 'v0', '', false)` },
  { fn: 'rag_relex_batch_stamped', sql: `SELECT * FROM public.rag_relex_batch_stamped('[]'::jsonb, 1, $1)` },
  { fn: 'rag_lexical_stale_count', sql: `SELECT * FROM public.rag_lexical_stale_count($1, 'v0')` },
  { fn: 'rag_index_document_chunks', sql: 'SELECT * FROM public.rag_index_document_chunks($1, $2::uuid, NULL, 10)', args: [ZERO_UUID] },
  {
    fn: 'rag_write_chunk_identifiers',
    sql: `SELECT * FROM public.rag_write_chunk_identifiers($1, $2::uuid, '[]'::jsonb)`,
    args: [ZERO_UUID],
    ownError: /^tenant_mismatch: document not found in tenant$/,
  },
  {
    fn: 'rag_write_table_rows',
    sql: `SELECT * FROM public.rag_write_table_rows($1, $2::uuid, 'legacy', '[]'::jsonb)`,
    args: [ZERO_UUID],
    ownError: /^tenant_mismatch: document not found in tenant$/,
  },
  { fn: 'rag_index_backfill_documents', sql: `SELECT * FROM public.rag_index_backfill_documents($1, 'tables', NULL, 10)` },
  { fn: 'rag_table_lookup', sql: `SELECT * FROM public.rag_table_lookup($1, ARRAY['v2cellk1', 'v2cellk3'], 2, 5, NULL, NULL)` },
  { fn: 'rag_dup_cluster_sources', sql: 'SELECT * FROM public.rag_dup_cluster_sources($1, ARRAY[]::uuid[], 5)' },
];
const WRONG_MODE = /tenant key not valid for this deployment mode/;

/** A key of the right mode passes the key check: the call succeeds or meets only the function's next, expected error. */
function assertKeyAccepted(entry: (typeof TENANT_KEY_FUNCTIONS)[number], tenantKey: string, message: string | null): void {
  if (message === null) return;
  assert.ok(entry.ownError?.test(message), `${entry.fn} refused ${tenantKey}: ${message}`);
}

/** The error message of one call as the service role, inside a transaction that is always rolled back; null when it succeeds. */
async function callWithKey(db: PGlite, entry: (typeof TENANT_KEY_FUNCTIONS)[number], tenantKey: string): Promise<string | null> {
  let message: string | null = null;
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE service_role');
    await db.query(entry.sql, [tenantKey, ...(entry.args ?? [])]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    await db.exec('ROLLBACK');
  }
  return message;
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
  let transformerModule: typeof import('@/lib/rag/query/transformer');
  let kbModule: typeof import('@/lib/rag/query/kb-languages');
  let langchainFakeModule: typeof import('@/lib/rag/query/langchain/fake');
  let fakeQueryLlmModule: typeof import('../../eval/harness/fake-query-llm.mts');
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
    await seedTwoTenantV2Lookups(fixture);
    await enableLexicalStats(fixture.db, LABELS.map((label) => fixture.seed.tenants[label].scopeKey));
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
    transformerModule = await import('@/lib/rag/query/transformer');
    kbModule = await import('@/lib/rag/query/kb-languages');
    langchainFakeModule = await import('@/lib/rag/query/langchain/fake');
    fakeQueryLlmModule = await import('../../eval/harness/fake-query-llm.mts');
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

  function isLookupPath(path: Path): path is LookupPath {
    return (LOOKUP_PATHS as Path[]).includes(path);
  }

  const supportsVersions = (profile: Profile) => profile !== 'voice';

  /** The caller asking with its own markers gets its own result for the path. */
  async function assertLookupPath(path: LookupPath, profile: Profile, label: V2TenantLabel, result: RetrievalResult, where: string): Promise<void> {
    const t = tenant(label);
    const ids = chunkIdsOf(result);
    if (path === 'table_lookup') {
      const record = stage(result, 'table_lookup');
      assert.equal(record?.status, 'ok', `${where}: table lookup ran (${JSON.stringify(record)})`);
      assert.match(record?.detail ?? '', /rows=1$/, `${where}: one own row`);
      assert.ok(ids.includes(t.lookup.tableChunkId), `${where}: own table chunk comes back`);
      const row = result.candidates.find((candidate) => candidate.chunk_id === t.lookup.tableChunkId);
      if (profile !== 'voice') assert.equal(row?.legs?.['table:0'], 1, `${where}: own row heads table:0 (${JSON.stringify(row?.legs)})`);
    }
    if (path === 'identifier') {
      const record = stage(result, 'identifier_resolve');
      assert.equal(record?.status, 'ok', `${where}: identifier resolve ran (${JSON.stringify(record)})`);
      assert.equal(record?.detail, 'asked=1 found=1 filtered=true', `${where}: own identifier found, filter applied`);
      assert.ok(ids.includes(t.lookup.identifierChunkId), `${where}: own identifier chunk comes back`);
      const lacking = result.candidates.filter((candidate) => !candidate.content.includes(t.markers.identifier)).map((candidate) => candidate.chunk_id);
      assert.deepEqual(lacking, [], `${where}: every candidate carries the asked identifier`);
      assert.equal(result.identifierSuggestions, undefined, `${where}: no suggestions when found`);
    }
    if (path === 'versions') {
      if (supportsVersions(profile)) {
        assert.ok(ids.includes(t.lookup.supersededChunkId), `${where}: own superseded chunk comes back under versions all`);
      } else {
        assert.ok(!ids.includes(t.lookup.supersededChunkId), `${where}: voice ignores the version scope`);
      }
    }
    if (path === 'dup_cluster') {
      const ownCopies = new Set(t.lookup.dupChunkIds);
      const ownDocs = new Set(t.lookup.dupDocumentIds);
      assert.ok(ids.some((id) => ownCopies.has(id)), `${where}: an own pasted copy comes back`);
      if (profile !== 'voice') {
        const kept = result.kept.filter((chunk) => ownCopies.has(chunk.chunk_id));
        assert.equal(kept.length, 1, `${where}: collapse keeps one copy (${kept.map((chunk) => chunk.chunk_id).join(',')})`);
        const alsoIn = kept[0]?.alsoIn ?? [];
        assert.ok(alsoIn.length > 0, `${where}: the other copies are listed`);
        for (const entry of alsoIn) assert.ok(ownDocs.has(entry.documentId), `${where}: alsoIn names ${entry.documentId}, not an own copy`);
      }
      await assertAlsoInOwn(label, result, where);
    }
  }

  /** Every alsoIn entry, on kept chunks and on used documents, is a document of the caller's tenant. */
  async function assertAlsoInOwn(label: V2TenantLabel, result: RetrievalResult, where: string): Promise<void> {
    const listed = [...result.kept.flatMap((chunk) => chunk.alsoIn ?? []), ...result.usedDocuments.flatMap((doc) => doc.alsoIn ?? [])].map((entry) => entry.documentId);
    const keys = await tenantKeys('documents', listed);
    for (const id of listed) assert.equal(keys.get(id), tenant(label).scopeKey, `${where}: alsoIn document ${id} belongs to ${keys.get(id) ?? 'nobody'}`);
  }

  /** The caller asking with another tenant's markers gets nothing of that tenant: no row, identifier, suggestion, superseded text or cluster member. */
  async function assertCrossTenant(path: LookupPath, profile: Profile, label: V2TenantLabel, scope: TenantScope, where: string): Promise<void> {
    for (const owner of LABELS) {
      if (owner === label) continue;
      const o = tenant(owner);
      const crossWhere = `${where} asking with ${owner}'s markers`;
      const filters = PATH_FILTERS[path];
      const { result, rerank } = await retrieve(scope, profile, QUERY_OF[path](o), filters ? { retrievalFilters: filters } : {});
      assert.ok(['ok', 'degraded', 'empty'].includes(result.status), `${crossWhere}: status ${result.status} (${result.reason})`);
      await assertOwnRows(label, result, crossWhere);
      await assertAlsoInOwn(label, result, crossWhere);
      const surfaces = {
        candidates: result.candidates,
        kept: result.kept,
        usedDocuments: result.usedDocuments,
        sourceImages: result.sourceImages,
        context: result.context,
        voiceResults: result.voice?.results ?? [],
        identifierSuggestions: result.identifierSuggestions ?? [],
        rerankDocuments: rerank.map((body) => body.documents),
      };
      assertNoForeignText(label, surfaces, crossWhere);
      const ids = chunkIdsOf(result);
      const foreignIds = [
        o.lookup.tableChunkId,
        o.lookup.identifierChunkId,
        o.lookup.siblingChunkId,
        o.lookup.supersededChunkId,
        o.lookup.currentChunkId,
        ...o.lookup.dupChunkIds,
      ];
      for (const id of foreignIds) assert.ok(!ids.includes(id), `${crossWhere}: foreign chunk ${id} received`);
      if (path === 'table_lookup') {
        const record = stage(result, 'table_lookup');
        if (record?.status === 'ok') assert.match(record.detail ?? '', /rows=0$/, `${crossWhere}: no foreign row`);
        assert.ok(!result.candidates.some((candidate) => candidate.legs && 'table:0' in candidate.legs), `${crossWhere}: no table:0 hit`);
      }
      if (path === 'identifier') {
        const record = stage(result, 'identifier_resolve');
        assert.match(record?.detail ?? '', /^asked=1 found=0 /, `${crossWhere}: the foreign identifier is reported missing (${JSON.stringify(record)})`);
        for (const suggestion of result.identifierSuggestions ?? []) {
          for (const foreign of [o.markers.identifier, o.markers.identifierSibling]) {
            assert.notEqual(suggestion.toLowerCase(), foreign.toLowerCase(), `${crossWhere}: suggestion names a foreign identifier`);
          }
        }
      }
      if (path === 'dup_cluster') {
        const sources = async (tenantKey: string, clusterId: string) =>
          (
            await db().transaction(async (tx) => {
              await tx.exec('SET LOCAL ROLE service_role');
              return tx.query<{ document_id: string }>('SELECT document_id::text AS document_id FROM public.rag_dup_cluster_sources($1, $2::uuid[], 30)', [tenantKey, [clusterId]]);
            })
          ).rows.map((row) => row.document_id);
        assert.deepEqual(await sources(tenant(label).scopeKey, o.lookup.dupClusterId), [], `${crossWhere}: the cluster sources call returns nothing of ${owner}`);
        assert.equal((await sources(o.scopeKey, o.lookup.dupClusterId)).length, V2_DUP_COPIES, `${crossWhere}: the owner sees its own cluster`);
      }
    }
  }

  for (const scoring of SCORINGS) {
  for (const profile of PROFILES) {
    for (const label of LABELS) {
      for (const path of PATHS) {
        const scoringName = scoring === 'bm25' ? ', scoring bm25' : '';
        test(`${profile} scope ${label}, path ${path}${scoringName}: only the caller's chunks, parents, sources, images and rerank input`, async () => {
          const where = `${profile}/${label}/${path}/${scoring}`;
          const t = tenant(label);
          const scope = await scopeFor(profile, label);
          assert.equal(scopeModule.scopeKey(scope), t.scopeKey);
          depsModule.setRagDepsForTests({ ragEnv: () => ({ ...allOnEnv, ...PATH_ENV[path], ...SCORING_ENV[scoring] }) });
          configModule.resetRagConfigForTests();
          try {
          const filters = PATH_FILTERS[path];
          const callsBefore = edge.calls.length;
          const { result, rerank } = await retrieve(scope, profile, QUERY_OF[path](t), filters ? { retrievalFilters: filters } : {});
          assertBm25Served(scoring, edge.calls.slice(callsBefore), result, where);

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
          if (isLookupPath(path)) await assertLookupPath(path, profile, label, result, where);
          assert.ok(rerank.length >= 1, `${where}: the rerank endpoint was called`);
          for (const body of rerank) {
            const surfaces = { query: body.query, documents: body.documents };
            assertNoForeignText(label, surfaces, `${where} rerank input`);
          }
          if (isLookupPath(path)) await assertCrossTenant(path, profile, label, scope, where);
          } finally {
            depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv });
            configModule.resetRagConfigForTests();
          }
        });
      }
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
      access: { mode: 'off' },
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

  for (const entry of TENANT_KEY_FUNCTIONS) {
    test(`${entry.fn} raises for the s:default key in multi-tenant mode and accepts a personal and an organization key`, async () => {
      assert.match((await callWithKey(db(), entry, 's:default')) ?? 'accepted', WRONG_MODE, `${entry.fn} accepted s:default`);
      for (const own of [tenant('a').scopeKey, tenant('o').scopeKey]) {
        assertKeyAccepted(entry, own, await callWithKey(db(), entry, own));
      }
    });
  }

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
            // quick-41 gate hardening: auto reaches Cohere only for AUTO_HOSTED_PROFILES (chat, embed, eval); voice keeps local_bm25
            if (variant.hosted && selectModule.AUTO_HOSTED_PROFILES.includes(profile)) {
              assert.ok(rerank.length >= 1, `${where}: auto with a Cohere key reranks on the edge`);
              for (const body of rerank) assertNoForeignText(label, { query: body.query, documents: body.documents }, `${where} rerank input`);
            } else {
              assert.equal(rerank.length, 0, `${where}: no key or a profile outside AUTO_HOSTED_PROFILES, no rerank request`);
              assert.equal(rerankStage?.detail, 'auto:local_bm25', `${where}: auto takes the local fallback`);
              assert.notEqual(rerankStage?.status, 'degraded', `${where}: the local fallback is not degraded`);
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

  type Framework = 'llamaindex' | 'langchain';
  type LayerCase = 'condensed' | 'expanded' | 'hyde' | 'sub_question' | 'translated';
  const FRAMEWORKS: Framework[] = ['llamaindex', 'langchain'];
  const LAYER_PROFILES: Profile[] = ['chat', 'embed', 'eval'];
  const LAYER_CASES: LayerCase[] = ['condensed', 'expanded', 'hyde', 'sub_question', 'translated'];
  const LAYER_HISTORY = [
    { role: 'user' as const, content: 'Tell me about the two tenant isolation canary handbook.' },
    { role: 'assistant' as const, content: 'The handbook lists its canary clauses.' },
  ];
  const LAYER_QUERY: Record<LayerCase, string> = {
    condensed: 'Which clause does it list first?',
    expanded: 'isolation canary handbook',
    hyde: 'isolation canary handbook',
    sub_question: 'What does the canary handbook clause say? Which catalogue item carries the canary phrase?',
    translated: V2_TRANSLATED_QUESTION,
  };
  const LAYER_TABLE = {
    version: 1 as const,
    entries: [
      {
        transform: 'condense' as const,
        query: LAYER_QUERY.condensed,
        output: { standalone: 'Which clause does the two tenant isolation canary handbook list first?', unchanged: false, language: null },
      },
      { transform: 'expand' as const, query: LAYER_QUERY.expanded, output: { queries: ['two tenant isolation canary phrase clause'] } },
      { transform: 'hyde' as const, query: LAYER_QUERY.hyde, output: { passage: 'Two tenant isolation canary phrase: clause one of the handbook.' } },
      {
        transform: 'decompose' as const,
        query: LAYER_QUERY.sub_question,
        output: { questions: ['What does the two tenant isolation canary clause say?', 'Which catalogue item carries the canary phrase?'] },
      },
      { transform: 'translate' as const, query: LAYER_QUERY.translated, output: { target_language: 'it', text: V2_TRANSLATED_TEXT, source_language: null } },
    ],
  };

  async function withQueryLayer<T>(framework: Framework, body: (fakes: { native: FakeQueryLlm; langchain: FakeLangChainChatModel }) => Promise<T>): Promise<T> {
    const native = fakeQueryLlmModule.createFakeQueryLlm({ table: LAYER_TABLE });
    const langchain = langchainFakeModule.createFakeLangChainChatModel({ table: LAYER_TABLE });
    const layerEnv: Record<string, string> = {
      ...allOnEnv,
      RAG_QUERY_LAYER: 'true',
      RAG_QUERY_FRAMEWORK: framework,
      RAG_QUERY_CONDENSE: 'true',
      RAG_QUERY_EXPAND: 'true',
      RAG_QUERY_HYDE: 'true',
      RAG_QUERY_DECOMPOSE: 'true',
      RAG_QUERY_TRANSLATE: 'true',
    };
    depsModule.setRagDepsForTests({ ragEnv: () => layerEnv, queryLlm: () => native });
    transformerModule.setLangChainChatModelFactoryForTests(() => langchain);
    configModule.resetRagConfigForTests();
    kbModule.resetKbLanguageCacheForTests();
    try {
      return await body({ native, langchain });
    } finally {
      transformerModule.setLangChainChatModelFactoryForTests(null);
      depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv, queryLlm: () => fakeQueryLlmModule.createFakeQueryLlm({ table: { version: 1, entries: [] } }) });
      configModule.resetRagConfigForTests();
      kbModule.resetKbLanguageCacheForTests();
    }
  }

  for (const framework of FRAMEWORKS) {
    for (const profile of LAYER_PROFILES) {
      for (const label of LABELS) {
        for (const kind of LAYER_CASES) {
          test(`RAG_QUERY_LAYER on, ${framework}, ${profile} scope ${label}, ${kind} variant: only the caller's chunks and text`, async () => {
            const where = `layer/${framework}/${profile}/${label}/${kind}`;
            await withQueryLayer(framework, async (fakes) => {
              const scope = await scopeFor(profile, label);
              const history = kind === 'condensed' ? LAYER_HISTORY : undefined;
              const { result, rerank } = await retrieve(scope, profile, LAYER_QUERY[kind], history ? { history } : {});
              assert.ok(['ok', 'degraded'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
              const plan = result.queryPlan;
              assert.ok(plan, `${where}: a query plan`);
              assert.equal(plan.framework, framework, `${where}: framework`);
              assert.ok(plan.variants, `${where}: plan variants`);
              assert.ok(
                plan.variants.some((variant) => variant.kind === kind),
                `${where}: plan variants ${plan.variants.map((variant) => variant.kind).join(',')}`,
              );
              const used = framework === 'langchain' ? fakes.langchain.calls.length : fakes.native.calls.length;
              const unused = framework === 'langchain' ? fakes.native.calls.length : fakes.langchain.calls.length;
              assert.ok(used > 0, `${where}: the ${framework} model wrote the variants`);
              assert.equal(unused, 0, `${where}: the other framework stays unused`);
              if (framework === 'langchain') {
                assert.equal(stage(result, 'framework_import')?.status, 'ok', `${where}: LangChain loaded`);
                assert.equal(stage(result, 'fuse')?.counts?.delegated, 1, `${where}: EnsembleRetriever fused the variant lists through the port`);
              }
              const index = plan.variants.findIndex((variant) => variant.kind === kind);
              const viaVariant = result.candidates.filter((row) => Object.keys(row.legs ?? {}).some((leg) => leg.endsWith(`:${index}`)));
              assert.ok(viaVariant.length > 0, `${where}: the ${kind} variant (index ${index}) found candidates`);
              await assertOwnRows(label, result, where);
              assertNoForeignText(label, { result, stages: result.stages, plan, rerankRequests: rerank }, where);
              assert.ok(chunkIdsOf(result).length > 0, `${where}: the caller's own chunks come back`);
            });
          });
        }
      }
    }
  }

  test('a langchain request in A, with B holding an identical-text chunk, returns only A chunk id through the port', async () => {
    const a = tenant('a');
    const b = tenant('b');
    const twinText = 'Shared twin sentence about the isolation canary handbook clause';
    const twinA = crypto.randomUUID();
    const twinB = crypto.randomUUID();
    const embedding = `[${embedText(twinText).join(',')}]`;
    for (const [owner, id] of [
      [a, twinA],
      [b, twinB],
    ] as const) {
      await db().query(
        `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata, organization_id, chunk_kind)
         VALUES ($1, $2, $3, $4::vector, 9, '{}'::jsonb, $5, 'text')`,
        [id, owner.exactDocumentId, twinText, embedding, owner.organizationId],
      );
    }
    await runFixtureRelex(db());
    try {
      await withQueryLayer('langchain', async () => {
        const { result } = await retrieve(await scopeFor('chat', 'a'), 'chat', LAYER_QUERY.expanded);
        assert.equal(result.queryPlan?.framework, 'langchain');
        assert.equal(stage(result, 'fuse')?.counts?.delegated, 1, 'the EnsembleRetriever delegate fused the lists');
        const ids = chunkIdsOf(result);
        assert.ok(ids.includes(twinA), 'own twin chunk comes back');
        assert.ok(!ids.includes(twinB), 'the other tenant twin chunk never comes back');
        await assertOwnRows('a', result, 'langchain twin');
      });
    } finally {
      await db().query('DELETE FROM document_chunks WHERE id = ANY($1::uuid[])', [[twinA, twinB]]);
    }
  });

  test('language shares feed translation per tenant: zh-heavy A translates an English query, en B does not, each reads its own shares', async () => {
    const a = tenant('a');
    const b = tenant('b');
    const question = 'Which clause of the isolation handbook names the canary phrase?';
    const translation = '隔离手册 金丝雀 条款';
    const table = { version: 1 as const, entries: [{ transform: 'translate' as const, query: question, output: { target_language: 'zh', text: translation, source_language: null } }] };
    const saved = await db().query<{ id: string; language: string | null }>(
      'SELECT id::text AS id, language FROM documents WHERE tenant_key = ANY($1::text[])',
      [[a.scopeKey, b.scopeKey]],
    );
    await db().query("UPDATE documents SET language = 'zh' WHERE tenant_key = $1", [a.scopeKey]);
    await db().query("UPDATE documents SET language = 'en' WHERE tenant_key = $1", [b.scopeKey]);
    const sharesCalls: Array<Record<string, unknown>> = [];
    const recordingAdmin = new Proxy(adminClient, {
      get(target, prop, receiver) {
        if (prop !== 'rpc') return Reflect.get(target, prop, receiver);
        return (fn: string, args: Record<string, unknown>, ...rest: unknown[]) => {
          if (fn === 'rag_tenant_language_shares') sharesCalls.push(args);
          return (target.rpc as (...params: unknown[]) => unknown)(fn, args, ...rest);
        };
      },
    }) as SupabaseClient;
    try {
      for (const framework of FRAMEWORKS) {
        await withQueryLayer(framework, async () => {
          const native = fakeQueryLlmModule.createFakeQueryLlm({ table });
          const langchain = langchainFakeModule.createFakeLangChainChatModel({ table });
          depsModule.setRagDepsForTests({ queryLlm: () => native, adminClient: () => recordingAdmin });
          transformerModule.setLangChainChatModelFactoryForTests(() => langchain);
          try {
            sharesCalls.length = 0;
            const inA = (await retrieve(await scopeFor('chat', 'a'), 'chat', question)).result;
            assert.deepEqual(sharesCalls, [{ p_tenant_key: a.scopeKey }], `${framework}: A reads only its own shares`);
            assert.ok(inA.queryPlan?.gate.reasons.includes('R8_LANGUAGE_MISMATCH'), `${framework}: A gate ${inA.queryPlan?.gate.reasons.join(',')}`);
            const translatedA = inA.queryPlan?.variants?.find((variant) => variant.kind === 'translated');
            assert.deepEqual({ text: translatedA?.text, language: translatedA?.language }, { text: translation, language: 'zh' }, `${framework}: A translated into zh`);
            await assertOwnRows('a', inA, `${framework} shares A`);

            sharesCalls.length = 0;
            const translateCallsBefore = framework === 'langchain' ? langchain.calls.length : native.calls.length;
            const inB = (await retrieve(await scopeFor('chat', 'b'), 'chat', question)).result;
            assert.deepEqual(sharesCalls, [{ p_tenant_key: b.scopeKey }], `${framework}: B reads only its own shares`);
            assert.ok(!inB.queryPlan?.gate.reasons.includes('R8_LANGUAGE_MISMATCH'), `${framework}: B does not translate`);
            assert.equal(inB.queryPlan?.variants?.some((variant) => variant.kind === 'translated'), false);
            const translateCallsAfter = framework === 'langchain' ? langchain.calls.length : native.calls.length;
            assert.equal(translateCallsAfter, translateCallsBefore, `${framework}: no translate call for B`);
            await assertOwnRows('b', inB, `${framework} shares B`);
          } finally {
            depsModule.setRagDepsForTests({ adminClient: () => adminClient });
          }
        });
      }
    } finally {
      for (const row of saved.rows) await db().query('UPDATE documents SET language = $1 WHERE id = $2', [row.language, row.id]);
    }
  });

  test('scoring bm25: a member removed from the organization gets no organization scope, and the BM25 leg serves only the personal tenant', async () => {
    const o = tenant('o');
    const a = tenant('a');
    depsModule.setRagDepsForTests({ ragEnv: () => ({ ...allOnEnv, ...SCORING_ENV.bm25 }) });
    configModule.resetRagConfigForTests();
    await db().query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [TWO_TENANT_IDS.orgO, o.userId]);
    try {
      const { resolveTenantScope } = await import('@/lib/rag/tenant/resolve-chat');
      const resolved = await resolveTenantScope({
        requestedOrganizationId: TWO_TENANT_IDS.orgO,
        deploymentMode: 'multi-tenant',
        getUser: async () => ({ id: o.userId }),
        admin: adminClient,
        signal: new AbortController().signal,
      });
      assert.equal(resolved.ok, false, 'the removed member is refused the organization scope');
      const callsBefore = edge.calls.length;
      const { result } = await retrieve(await scopeFor('chat', 'a'), 'chat', V2_EXACT_QUERY);
      assertBm25Served('bm25', edge.calls.slice(callsBefore), result, 'removed member, personal scope');
      await assertOwnRows('a', result, 'removed member, personal scope');
      const keys = await tenantKeys('document_chunks', chunkIdsOf(result));
      assert.ok(![...keys.values()].includes(o.scopeKey), 'no organization chunk reaches the removed member');
      assert.equal(scopeModule.scopeKey(await scopeFor('chat', 'a')), a.scopeKey);
    } finally {
      await db().query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [TWO_TENANT_IDS.orgO, o.userId]);
      depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv });
      configModule.resetRagConfigForTests();
    }
  });

  test('scoring bm25, DF mode cluster (04.4-17): a cluster-ready tenant is served on chunks_cluster, a tenant without cluster statistics by raw BM25, each inside its own tenant', async () => {
    const statsModule = await import('@/lib/rag/lexical/stats');
    const a = tenant('a');
    const env = { ...allOnEnv, ...PATH_ENV.dup_cluster, ...SCORING_ENV.bm25, RAG_LEXICAL_DF_MODE: 'cluster' };
    depsModule.setRagDepsForTests({ ragEnv: () => env });
    configModule.resetRagConfigForTests();
    await asServiceRole(db(), 'SELECT public.rag_lexstats_cluster_enable($1)', [a.scopeKey]);
    await asServiceRole(db(), 'SELECT public.rag_lexstats_rebuild($1)', [a.scopeKey]);
    statsModule.resetLexstatsCacheForTests();
    try {
      for (const [label, code] of [
        ['a', 'lexical_df_cluster'],
        ['b', 'lexical_df_cluster_unavailable'],
      ] as const) {
        const where = `DF mode cluster, tenant ${label}`;
        const callsBefore = edge.calls.length;
        const { result } = await retrieve(await scopeFor('chat', label), 'chat', V2_EXACT_QUERY);
        const calls = edge.calls.slice(callsBefore);
        assertBm25Served('bm25', calls, result, where);
        assert.ok(['ok', 'degraded'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
        const detail = stage(result, 'search')?.detail ?? '';
        assert.ok(detail.split(';').includes('lexical_scoring_bm25'), `${where}: ${detail}`);
        assert.ok(detail.split(';').includes(code), `${where}: ${detail}`);
        await assertOwnRows(label, result, where);
        assertNoForeignText(label, { result, stages: result.stages, rerankRequests: [] }, where);
      }
    } finally {
      await asServiceRole(db(), 'SELECT public.rag_lexstats_cluster_disable($1)', [a.scopeKey]);
      statsModule.resetLexstatsCacheForTests();
      depsModule.setRagDepsForTests({ ragEnv: () => allOnEnv });
      configModule.resetRagConfigForTests();
    }
  });

  test('the fixture edge saw no unsupported request', () => {
    assert.deepEqual(edge.errors, []);
  });
});

describe('the BM25 leg reads only the caller statistics: direct calls, score stability under another tenant, delete and version replace', () => {
  let fixture: TwoTenantV2Database;
  const db = (): PGlite => fixture.db;
  const tenant = (label: V2TenantLabel): TwoTenantV2Tenant => fixture.seed.tenants[label];

  interface Bm25Row {
    chunk_id: string;
    lexical_score: number;
  }

  const bm25 = (tenantKey: string, tokens: readonly string[]) =>
    asServiceRole<Bm25Row>(
      db(),
      `SELECT chunk_id::text AS chunk_id, lexical_score
         FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
                                            p_lexical_tokens => $3::text[], p_lexical_limit => 200)
        WHERE leg = 'lexical' ORDER BY rank`,
      [tenantKey, V2_LEGACY_EMBEDDING_PROFILE, [...tokens]],
    );

  /** Folds every staged delta of the tenant, as the purge hook and the scheduled compaction do. */
  async function compact(tenantKey: string): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      const [row] = await asServiceRole<{ n: string | number }>(db(), 'SELECT public.rag_lexstats_compact($1, 50000) AS n', [tenantKey]);
      if (Number(row?.n ?? 0) === 0) return;
    }
    assert.fail(`compaction of ${tenantKey} did not finish`);
  }

  async function assertClean(tenantKey: string, where: string): Promise<void> {
    const [row] = await asServiceRole<{ check: Record<string, unknown> }>(db(), 'SELECT public.rag_lexstats_check($1) AS check', [tenantKey]);
    assert.equal(row?.check.clean, true, `${where}: ${tenantKey} statistics check ${JSON.stringify(row?.check)}`);
    assert.equal(Number(row?.check.pending), 0, `${where}: nothing staged after compaction`);
  }

  async function ownerKeys(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db().query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [[...ids]]);
    return rows.rows.map((row) => row.tenant_key);
  }

  /** Inserts one current, ready document of the tenant with one chunk per lexical text; triggers stage the deltas. */
  async function ingest(owner: TwoTenantV2Tenant, texts: readonly string[]): Promise<{ documentId: string; chunkIds: string[] }> {
    const documentId = crypto.randomUUID();
    await db().query(
      `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, doc_type, language, is_current, status)
       VALUES ($1, $2, 'neutral sample', '{}'::jsonb, $3::uuid, $4::uuid, 'general', 'en', true, 'ready')`,
      [documentId, `bm25-matrix-${documentId.slice(0, 8)}.txt`, owner.userId, owner.organizationId],
    );
    const chunkIds = texts.map(() => crypto.randomUUID());
    await db().query(
      `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, chunk_kind,
         chunking_profile_id, status, is_current, organization_id)
       SELECT u.id, $1::uuid, u.txt, '{}'::jsonb, u.ord::int - 1, u.txt, 'en', 'general', 'text', 'legacy', 'ready', true, $4::uuid
         FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS u(id, txt, ord)`,
      [documentId, chunkIds, [...texts], owner.organizationId],
    );
    assert.deepEqual(await ownerKeys(chunkIds), [owner.scopeKey], 'seeded chunks belong to the owner');
    return { documentId, chunkIds };
  }

  let queries: string[][] = [];
  let ownTexts: string[] = [];

  before(async () => {
    fixture = await createTwoTenantV2Database();
    await enableLexicalStats(fixture.db, LABELS.map((label) => fixture.seed.tenants[label].scopeKey));
    const a = fixture.seed.tenants.a;
    const lexemes = (
      await fixture.db.query<{ lexeme: string }>(
        `SELECT DISTINCT x.lexeme FROM document_chunks c, unnest(tsvector_to_array(c.lexical_tsv)) AS x(lexeme)
          WHERE c.tenant_key = $1 AND c.is_current AND c.lexical_tsv IS NOT NULL ORDER BY 1`,
        [a.scopeKey],
      )
    ).rows.map((row) => row.lexeme);
    assert.ok(lexemes.length >= 6, `tenant a has lexemes (${lexemes.length})`);
    queries = [V2_CANARY_QUERY.toLowerCase().split(/\s+/), lexemes.slice(0, 3), lexemes.slice(-3)];
    ownTexts = (
      await fixture.db.query<{ lexical_text: string }>(
        `SELECT lexical_text FROM document_chunks WHERE tenant_key = $1 AND is_current AND lexical_text IS NOT NULL ORDER BY id LIMIT 5`,
        [a.scopeKey],
      )
    ).rows.map((row) => row.lexical_text);
    assert.ok(ownTexts.length > 0, 'tenant a has lexical text');
  });

  after(async () => {
    await fixture?.db.close();
  });

  test('every tenant scope gets rows of its own tenant only, for the same shared tokens', async () => {
    for (const label of LABELS) {
      const t = tenant(label);
      let seen = 0;
      for (const tokens of queries) {
        const rows = await bm25(t.scopeKey, tokens);
        seen += rows.length;
        const keys = await ownerKeys(rows.map((row) => row.chunk_id));
        assert.ok(keys.every((key) => key === t.scopeKey), `${label}: rows of ${keys.join(', ')}`);
      }
      assert.ok(seen > 0, `${label}: its own chunks come back`);
    }
  });

  test('a key the scenario forbids returns nothing: another deployment mode, a malformed key, a tenant without ready statistics', async () => {
    for (const key of ['s:default', 'u:not-a-uuid', 'x:anything', '']) {
      await assert.rejects(() => bm25(key, queries[0] as string[]), `${key || '(empty)'} is refused`);
    }
    const stranger = `u:${crypto.randomUUID()}`;
    await assert.rejects(
      () => bm25(stranger, queries[0] as string[]),
      (error: unknown) => (error as { code?: string }).code === '55000',
      'a tenant without statistics is not served',
    );
  });

  test('DF mode cluster (04.4-17): with a clustered and an unclustered tenant both cluster-enabled, neither ranking moves when the other tenant clusters or deletes chunks', async () => {
    const a = tenant('a');
    const b = tenant('b');
    const tokens = queries[1] as string[];
    const clusterBm25 = (tenantKey: string) =>
      asServiceRole<Bm25Row>(
        db(),
        `SELECT chunk_id::text AS chunk_id, lexical_score
           FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
                                              p_lexical_tokens => $3::text[], p_lexical_limit => 200, p_df_mode => 'cluster')
          WHERE leg = 'lexical' ORDER BY rank`,
        [tenantKey, V2_LEGACY_EMBEDDING_PROFILE, [...tokens]],
      );
    const newCluster = async (tenantKey: string): Promise<string> =>
      (
        await db().query<{ id: string }>('INSERT INTO public.rag_dup_clusters (tenant_key, embedding_profile_id) VALUES ($1, $2) RETURNING id', [
          tenantKey,
          V2_LEGACY_EMBEDDING_PROFILE,
        ])
      ).rows[0]!.id;
    for (const key of [a.scopeKey, b.scopeKey]) {
      await asServiceRole(db(), 'SELECT public.rag_lexstats_cluster_enable($1)', [key]);
      await asServiceRole(db(), 'SELECT public.rag_lexstats_rebuild($1)', [key]);
    }
    try {
      // Tenant a holds a cluster of five copies; tenant b holds none yet.
      const copies = await ingest(a, Array.from({ length: 5 }, () => `${tokens.join(' ')} w7101 w7102`));
      const aCluster = await newCluster(a.scopeKey);
      await db().query('UPDATE document_chunks SET dup_cluster_id = $2::uuid WHERE id = ANY($1::uuid[])', [copies.chunkIds, aCluster]);
      await compact(a.scopeKey);
      const aBaseline = await clusterBm25(a.scopeKey);
      const bBaseline = await clusterBm25(b.scopeKey);
      assert.ok(aBaseline.length > 0 && bBaseline.length > 0, 'both tenants find their own chunks');
      assert.deepEqual(await ownerKeys(aBaseline.map((row) => row.chunk_id)), [a.scopeKey]);
      assert.deepEqual(await ownerKeys(bBaseline.map((row) => row.chunk_id)), [b.scopeKey]);

      // b clusters copies of its own, then deletes them: a does not move.
      const bCopies = await ingest(b, Array.from({ length: 8 }, () => `${tokens.join(' ')} w7201`));
      const bCluster = await newCluster(b.scopeKey);
      await db().query('UPDATE document_chunks SET dup_cluster_id = $2::uuid WHERE id = ANY($1::uuid[])', [bCopies.chunkIds, bCluster]);
      await compact(b.scopeKey);
      assert.deepEqual(await clusterBm25(a.scopeKey), aBaseline, 'a after b clusters');
      await db().query('DELETE FROM document_chunks WHERE id = ANY($1::uuid[])', [bCopies.chunkIds]);
      await compact(b.scopeKey);
      assert.deepEqual(await clusterBm25(a.scopeKey), aBaseline, 'a after b deletes');
      assert.deepEqual(await clusterBm25(b.scopeKey), bBaseline, 'b is back at its baseline');

      // a deletes its clustered copies: b does not move.
      await db().query('DELETE FROM document_chunks WHERE id = ANY($1::uuid[])', [copies.chunkIds]);
      await compact(a.scopeKey);
      assert.deepEqual(await clusterBm25(b.scopeKey), bBaseline, 'b after a deletes its cluster');
      await assertClean(a.scopeKey, 'cluster mode, a');
      await assertClean(b.scopeKey, 'cluster mode, b');
    } finally {
      for (const key of [a.scopeKey, b.scopeKey]) await asServiceRole(db(), 'SELECT public.rag_lexstats_cluster_disable($1)', [key]);
    }
  });

  test("tenant a's ids and scores are bit-identical while tenant b ingests 50 chunks of a's tokens, updates 10 and deletes 10", async () => {
    const a = tenant('a');
    const b = tenant('b');
    const snapshot = async () => Promise.all(queries.map((tokens) => bm25(a.scopeKey, tokens)));
    const baseline = await snapshot();
    assert.ok(baseline.every((rows) => rows.length > 0), 'every query finds chunks of a');
    const bBefore = await bm25(b.scopeKey, queries[1] as string[]);

    const texts = Array.from({ length: 50 }, (_, i) => `${ownTexts[i % ownTexts.length]} ${(queries[1] as string[]).join(' ')} w${i}`);
    const { chunkIds } = await ingest(b, texts);
    await compact(b.scopeKey);
    assert.deepEqual(await snapshot(), baseline, 'after b ingests');
    await assertClean(b.scopeKey, 'after b ingests');
    const bAfter = await bm25(b.scopeKey, queries[1] as string[]);
    assert.ok(bAfter.length >= Math.min(200, bBefore.length + 50), "b's own result grows with its writes");

    await db().query(
      `UPDATE document_chunks SET lexical_text = lexical_text || ' ' || $2 WHERE id = ANY($1::uuid[])`,
      [chunkIds.slice(0, 10), (queries[2] as string[]).join(' ')],
    );
    await compact(b.scopeKey);
    assert.deepEqual(await snapshot(), baseline, 'after b updates');
    await assertClean(b.scopeKey, 'after b updates');

    await db().query('DELETE FROM document_chunks WHERE id = ANY($1::uuid[])', [chunkIds.slice(10, 20)]);
    await compact(b.scopeKey);
    assert.deepEqual(await snapshot(), baseline, 'after b deletes');
    await assertClean(b.scopeKey, 'after b deletes');
    await assertClean(a.scopeKey, 'tenant a untouched');
  });

  test("RAG_RERANK_LOCAL_STATS=tenant (04.4-21): tenant a's local rerank scores read a's statistics only and do not move while tenant b writes", async () => {
    const { createLocalBm25Reranker, LOCAL_BM25_TENANT_MODEL } = await import('../../src/lib/rag/rerank/local-bm25.ts');
    const { createTenantLocalStatsProvider } = await import('../../src/lib/rag/rerank/local-stats.ts');
    const { resetLexstatsCacheForTests } = await import('../../src/lib/rag/lexical/stats.ts');
    type Rpc = import('../../src/lib/rag/backend/supabase-rpc.ts').RpcClient;
    const rpcCalls: Array<{ fn: string; tenant: unknown }> = [];
    const client: Rpc = {
      rpc(fn, args) {
        rpcCalls.push({ fn, tenant: args.p_tenant_key });
        const run = async () => {
          try {
            if (fn === 'rag_lexstats_status') {
              return { data: await asServiceRole(db(), 'SELECT public.rag_lexstats_status($1) AS rag_lexstats_status', [args.p_tenant_key]), error: null };
            }
            const rows = await asServiceRole<Record<string, unknown>>(
              db(),
              'SELECT chunk_id::text AS chunk_id, chunk_count, total_len, terms, dfs FROM public.rag_lexical_rerank_stats($1, $2::text[], $3::uuid[])',
              [args.p_tenant_key, args.p_terms, args.p_chunk_ids],
            );
            return { data: rows, error: null };
          } catch (error) {
            return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
          }
        };
        const request = { abortSignal: () => request, then: (ok: never, ko: never) => run().then(ok, ko) } as unknown as ReturnType<Rpc['rpc']>;
        return request;
      },
    };
    const a = tenant('a');
    const b = tenant('b');
    const candidates = (
      await db().query<{ id: string; lexical_text: string }>(
        `SELECT id::text AS id, lexical_text FROM document_chunks
          WHERE tenant_key = $1 AND is_current AND lexical_text IS NOT NULL AND lexical_text <> '' ORDER BY id LIMIT 12`,
        [a.scopeKey],
      )
    ).rows;
    assert.ok(candidates.length > 1, 'tenant a has rerank candidates');
    const query = [...new Set(candidates.flatMap((row) => row.lexical_text.split(' ').slice(0, 2)))].slice(0, 4).join(' ');
    const rerankA = async () => {
      resetLexstatsCacheForTests();
      const localStats = createTenantLocalStatsProvider({ client, tenantKey: a.scopeKey, chunkIds: candidates.map((row) => row.id) });
      return createLocalBm25Reranker().rerank(query, candidates.map((row) => row.lexical_text), { signal: AbortSignal.timeout(30_000), localStats });
    };
    const terms = [...new Set(query.split(' '))];
    const readA = async () => {
      resetLexstatsCacheForTests();
      const provider = createTenantLocalStatsProvider({ client, tenantKey: a.scopeKey, chunkIds: candidates.map((row) => row.id) });
      const map = await provider.read(terms, candidates.map((row) => row.id), AbortSignal.timeout(30_000));
      return map === null ? null : [...map.entries()].map(([id, g]) => [id, g.chunkCount, g.totalLength, [...g.df.entries()].sort()]);
    };
    const statsBefore = await readA();
    assert.ok(statsBefore !== null && statsBefore.length === candidates.length, 'every candidate of a has statistics');
    const baseline = await rerankA();
    assert.equal(baseline.localStats, 'tenant', 'tenant statistics served a');
    assert.equal(baseline.model, LOCAL_BM25_TENANT_MODEL);
    assert.ok(baseline.scores.every((row) => Number.isFinite(row.score)), 'finite scores');
    assert.ok(rpcCalls.every((call) => call.tenant === a.scopeKey), 'every read names tenant a only');

    const { chunkIds } = await ingest(b, Array.from({ length: 40 }, (_, i) => `${query} ${query} w${i}`));
    await compact(b.scopeKey);
    assert.deepEqual(await rerankA(), baseline, 'after b ingests');
    assert.deepEqual(await readA(), statsBefore, "a's statistics after b ingests a's terms");
    // A chunk id of b among a's candidates gets no statistics under a's key, so the pool serves that request (never b's statistics).
    resetLexstatsCacheForTests();
    const mixed = await createLocalBm25Reranker().rerank(query, [...candidates.map((row) => row.lexical_text), 'x'], {
      signal: AbortSignal.timeout(30_000),
      localStats: createTenantLocalStatsProvider({ client, tenantKey: a.scopeKey, chunkIds: [...candidates.map((row) => row.id), chunkIds[0] as string] }),
    });
    assert.equal(mixed.localStats, 'pool');
    await db().query('DELETE FROM document_chunks WHERE id = ANY($1::uuid[])', [chunkIds.slice(0, 20)]);
    await compact(b.scopeKey);
    assert.deepEqual(await rerankA(), baseline, 'after b deletes');
    assert.deepEqual(await readA(), statsBefore, "a's statistics after b deletes");
    assert.ok(rpcCalls.every((call) => call.tenant === a.scopeKey), 'no read named another tenant');
  });

  test("after delete and version replace within tenant a, the removed and superseded chunks are gone and b's result does not move", async () => {
    const a = tenant('a');
    const b = tenant('b');
    const tokens = queries[1] as string[];
    const bBaseline = await bm25(b.scopeKey, tokens);

    const own = await ingest(a, [`${tokens.join(' ')} w7001`, `${tokens.join(' ')} w7002`]);
    await compact(a.scopeKey);
    const before = (await bm25(a.scopeKey, tokens)).map((row) => row.chunk_id);
    assert.ok(own.chunkIds.every((id) => before.includes(id)), 'the new chunks of a are found');

    await db().query('DELETE FROM document_chunks WHERE id = $1', [own.chunkIds[0]]);
    await compact(a.scopeKey);
    const afterDelete = (await bm25(a.scopeKey, tokens)).map((row) => row.chunk_id);
    assert.ok(!afterDelete.includes(own.chunkIds[0] as string), 'the deleted chunk is absent');
    await assertClean(a.scopeKey, 'after delete');

    await db().query('UPDATE documents SET is_current = false WHERE id = $1', [own.documentId]);
    await db().query('UPDATE document_chunks SET is_current = false WHERE document_id = $1', [own.documentId]);
    const replacement = await ingest(a, [`${tokens.join(' ')} w7003`]);
    await compact(a.scopeKey);
    const afterReplace = (await bm25(a.scopeKey, tokens)).map((row) => row.chunk_id);
    assert.ok(!afterReplace.includes(own.chunkIds[1] as string), 'the superseded chunk is absent');
    assert.ok(afterReplace.includes(replacement.chunkIds[0] as string), 'the replacing version is found');
    assert.deepEqual(await ownerKeys(afterReplace), [a.scopeKey]);
    await assertClean(a.scopeKey, 'after version replace');

    assert.deepEqual(await bm25(b.scopeKey, tokens), bBaseline, "b's ids and scores do not move with a's writes");
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
  const owner: V2LookupOwner = singleTenantLookupOwner();

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
    await seedLookupRows(fixture.db, owner);
    await clusterLookupCopies(fixture.db, [owner]);
    await enableLexicalStats(fixture.db, ['s:default']);
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

  const run = (scope: TenantScope, query = 'what is the refund policy', extra: Partial<import('@/lib/rag').RunRetrievalInput> = {}) =>
    rag.runRetrieval({ scope, query, profile: 'eval', options: OPTIONS, signal: new AbortController().signal, ...extra });

  for (const scoring of SCORINGS)
  for (const path of LOOKUP_PATHS) {
    test(`path ${path}${scoring === 'bm25' ? ', scoring bm25' : ''}: the default tenant gets its own result, a personal and an organization key are refused`, async () => {
      depsModule.setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', ...PATH_ENV[path], ...SCORING_ENV[scoring] }) });
      configModule.resetRagConfigForTests();
      try {
        const where = `single-tenant/${path}/${scoring}`;
        const filters = PATH_FILTERS[path];
        const extra = filters ? { retrievalFilters: filters } : {};
        const query = QUERY_OF[path]({ markers: owner.markers } as TwoTenantV2Tenant);
        const callsBefore = edge.calls.length;
        const result = await run(scopeModule.mintScope('single', null, null), query, extra);
        assertBm25Served(scoring, edge.calls.slice(callsBefore), result, where);
        assert.ok(['ok', 'degraded'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
        const ids = new Set([...result.candidates.map((row) => row.chunk_id), ...result.kept.map((row) => row.chunk_id)]);
        const keys = await fixture.db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [[...ids]]);
        assert.deepEqual(keys.rows.map((row) => row.tenant_key), ['s:default'], `${where}: only default-tenant chunks`);
        const stageOf = (name: string) => result.stages.find((record) => record.name === name);
        if (path === 'table_lookup') {
          assert.match(stageOf('table_lookup')?.detail ?? '', /rows=1$/, `${where}: one row`);
          assert.equal(result.candidates.find((row) => row.chunk_id === owner.lookup.tableChunkId)?.legs?.['table:0'], 1, `${where}: the row chunk heads table:0`);
        }
        if (path === 'identifier') {
          assert.equal(stageOf('identifier_resolve')?.detail, 'asked=1 found=1 filtered=true', `${where}: filter applied`);
          assert.ok(ids.has(owner.lookup.identifierChunkId), `${where}: the identifier chunk comes back`);
          assert.ok(result.candidates.every((row) => row.content.includes(owner.markers.identifier)), `${where}: every candidate carries the identifier`);
        }
        if (path === 'versions') assert.ok(ids.has(owner.lookup.supersededChunkId), `${where}: the superseded chunk comes back under versions all`);
        if (path === 'dup_cluster') {
          const kept = result.kept.filter((row) => owner.lookup.dupChunkIds.includes(row.chunk_id));
          assert.equal(kept.length, 1, `${where}: collapse keeps one copy`);
          const listed = (kept[0]?.alsoIn ?? []).map((entry) => entry.documentId);
          assert.ok(listed.length > 0 && listed.every((id) => owner.lookup.dupDocumentIds.includes(id)), `${where}: alsoIn lists the other copies only`);
        }
        for (const scope of [scopeModule.mintScope('personal', TWO_TENANT_IDS.userA, null), scopeModule.mintScope('org', null, TWO_TENANT_IDS.orgO)]) {
          const refused = await run(scope, query, extra);
          assert.equal(refused.status, 'error', `${where}: ${scopeModule.scopeKey(scope)} is refused`);
          assert.equal(refused.reason, 'backend_error');
          assert.equal(refused.candidates.length, 0);
          assert.equal(refused.context, '');
        }
      } finally {
        depsModule.setRagDepsForTests({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
        configModule.resetRagConfigForTests();
      }
    });
  }

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

  for (const entry of TENANT_KEY_FUNCTIONS) {
    test(`${entry.fn} raises for u: and o: keys in single-tenant mode and accepts s:default`, async () => {
      for (const foreign of [`u:${TWO_TENANT_IDS.userA}`, `o:${TWO_TENANT_IDS.orgO}`]) {
        assert.match((await callWithKey(fixture.db, entry, foreign)) ?? 'accepted', WRONG_MODE, `${entry.fn} accepted ${foreign}`);
      }
      assertKeyAccepted(entry, 's:default', await callWithKey(fixture.db, entry, 's:default'));
    });
  }

  test('rag_bm25_search_chunks raises for u: and o: keys and serves s:default its own chunks only', async () => {
    const call = (key: string) =>
      asServiceRole<{ chunk_id: string }>(
        fixture.db,
        `SELECT chunk_id::text AS chunk_id FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL,
           p_lexical_tokens => ARRAY['refund', 'policy'], p_lexical_limit => 50) WHERE leg = 'lexical'`,
        [key, V2_LEGACY_EMBEDDING_PROFILE],
      );
    const own = await call('s:default');
    assert.ok(own.length > 0, 'the default tenant is served');
    const keys = await fixture.db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [own.map((row) => row.chunk_id)]);
    assert.deepEqual(keys.rows.map((row) => row.tenant_key), ['s:default']);
    for (const key of [`u:${TWO_TENANT_IDS.userA}`, `o:${TWO_TENANT_IDS.orgO}`]) await assert.rejects(() => call(key), `${key} is refused`);
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

/**
 * 06.2-36 (T-06.2-86; D-06, D-13, D-24, D-25): the Phase 6.2 components that touch a tenant, in both deployment modes. Each row turns on
 * only its own 6.2 switch (RAG_QUERY_SUBQ_FILTERS, RAG_TRANSLATION_GLOSSARY, RAG_SCOPE_GATE, RAG_WHATSAPP_HISTORY) on top of the query
 * layer; in single-tenant mode the other tenant is a personal key, which every component refuses.
 */
for (const mode of ['multi-tenant', 'single-tenant'] as Q62Mode[]) {
  describe(`Phase 6.2 canary rows stay inside the caller tenant (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    let client: SupabaseClient;
    let seed: Q62Seed;
    let rag: typeof import('@/lib/rag');
    let scopeModule: typeof import('@/lib/rag/tenant/scope');
    let depsModule: typeof import('@/lib/rag/deps');
    let registryModule: typeof import('@/lib/rag/backend/registry');
    let configModule: typeof import('@/lib/rag/config');
    let vocabularyModule: typeof import('@/lib/rag/query/tenant-vocabulary');
    let languageSettings: typeof import('@/lib/rag/lang/settings');
    let terminologyLoad: typeof import('@/lib/rag/terminology/load');
    let lexiconModule: typeof import('@/lib/rag/terminology/lexicon');
    let fakeQueryLlmModule: typeof import('../../eval/harness/fake-query-llm.mts');
    const previousEnv = { ...process.env } as Record<string, string | undefined>;
    const BASE_ENV: Record<string, string> = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_QUERY_LAYER: 'true' };
    /** A personal key of a user with no rows: in single-tenant mode it stands for "another tenant" and must be refused. */
    const foreignPersonal = () => scopeModule.mintScope('personal', TWO_TENANT_IDS.userB, null);
    const others = (): Q62Tenant[] => (seed.b ? [seed.b] : []);

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      edge = await startFakeEdge({ db });
      const processEnv = fixtureProcessEnv(edge.url);
      Object.assign(process.env, processEnv, CI_LANGUAGES);
      process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
      process.env.MYRAG_DEPLOYMENT_MODE = mode;
      seed = await seedQ62CanaryRows(db, mode);
      rag = await import('@/lib/rag');
      scopeModule = await import('@/lib/rag/tenant/scope');
      depsModule = await import('@/lib/rag/deps');
      registryModule = await import('@/lib/rag/backend/registry');
      configModule = await import('@/lib/rag/config');
      vocabularyModule = await import('@/lib/rag/query/tenant-vocabulary');
      languageSettings = await import('@/lib/rag/lang/settings');
      terminologyLoad = await import('@/lib/rag/terminology/load');
      lexiconModule = await import('@/lib/rag/terminology/lexicon');
      fakeQueryLlmModule = await import('../../eval/harness/fake-query-llm.mts');
      languageSettings.resetLanguageSettingsForTests();
      client = createClient(edge.url, processEnv.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
    });

    after(async () => {
      depsModule?.resetRagDepsForTests();
      registryModule?.resetRetrievalBackendForTests();
      configModule?.resetRagConfigForTests();
      vocabularyModule?.resetTenantVocabularyCacheForTests();
      terminologyLoad?.invalidateTerminologyCache('all');
      lexiconModule?.resetTerminologyLexiconForTests();
      await edge?.close();
      await db?.close();
      for (const name of Object.keys(process.env)) {
        if (!(name in previousEnv)) delete process.env[name];
      }
      Object.assign(process.env, previousEnv);
      languageSettings?.resetLanguageSettingsForTests();
    });

    /** Turns on the query layer plus exactly the given 6.2 switches, with the fixture embedder and the given clients. */
    function useSwitches(switches: Record<string, string>, extra: Partial<Parameters<typeof depsModule.setRagDepsForTests>[0]> = {}): void {
      depsModule.resetRagDepsForTests();
      depsModule.setRagDepsForTests({ ragEnv: () => ({ ...BASE_ENV, ...switches }), adminClient: () => client, embedder: async (text) => embedText(text), ...extra });
      registryModule.resetRetrievalBackendForTests();
      configModule.resetRagConfigForTests();
      vocabularyModule.resetTenantVocabularyCacheForTests();
      terminologyLoad.invalidateTerminologyCache('all');
      lexiconModule.resetTerminologyLexiconForTests();
    }

    async function keysOf(chunkIds: readonly string[]): Promise<string[]> {
      if (chunkIds.length === 0) return [];
      const rows = await db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM document_chunks WHERE id = ANY($1::uuid[])', [[...chunkIds]]);
      return rows.rows.map((row) => row.tenant_key).sort();
    }

    const idsOf = (result: RetrievalResult): string[] => [...new Set([...result.candidates.map((row) => row.chunk_id), ...result.kept.map((row) => row.chunk_id)])];
    const run = (scope: TenantScope, query: string, extra: Partial<import('@/lib/rag').RunRetrievalInput> = {}) =>
      rag.runRetrieval({ scope, query, profile: 'chat', options: OPTIONS, signal: new AbortController().signal, ...extra });

    test(`RAG_QUERY_SUBQ_FILTERS: a sub-question filter naming another tenant's doc type is dropped and never widens tenant A's search (${mode})`, async () => {
      const fake = fakeQueryLlmModule.createFakeQueryLlm({ table: q62DecomposeTable() as never });
      useSwitches({ RAG_QUERY_DECOMPOSE: 'true', RAG_QUERY_SUBQ_FILTERS: 'true', RAG_QUERY_CONDENSE: 'false', RAG_QUERY_EXPAND: 'false', RAG_QUERY_TRANSLATE: 'false', RAG_QUERY_DATE_NORMALIZE: 'false' }, { queryLlm: () => fake });
      const where = `${mode}/subq_filters`;
      const scopeA = await q62Scope(seed.a);
      assert.ok(!(await vocabularyModule.loadTenantDocTypes(scopeA))?.includes(Q62_FOREIGN_DOC_TYPE), `${where}: tenant A's doc-type vocabulary holds none of B's`);

      const result = await run(scopeA, Q62_QUESTION);
      assert.ok(['ok', 'degraded'].includes(result.status), `${where}: status ${result.status} (${result.reason})`);
      assert.ok(fake.calls.some((call) => call.transform === 'decompose'), `${where}: the scripted decomposer ran`);
      const plan = result.queryPlan;
      assert.ok(plan?.variants, `${where}: a query plan`);
      const statuses = (plan.filter_trace ?? []).map((entry) => entry.status);
      assert.deepEqual(statuses, ['dropped_unknown_values', 'applied'], `${where}: filter trace ${JSON.stringify(plan.filter_trace)}`);
      const ids = idsOf(result);
      assert.ok(ids.length > 0, `${where}: tenant A's own chunks come back`);
      assert.deepEqual(await keysOf(ids), [seed.a.key], `${where}: only tenant A chunks`);
      const ownIndex = plan.variants.findIndex((variant) => variant.text === Q62_SUB_OWN);
      const viaOwn = result.candidates.filter((row) => Object.keys(row.legs ?? {}).some((leg) => leg.endsWith(`:${ownIndex}`))).map((row) => row.chunk_id);
      assert.ok(viaOwn.length > 0, `${where}: the narrowed part retrieved`);
      const types = await db.query<{ doc_type: string }>('SELECT DISTINCT doc_type FROM document_chunks WHERE id = ANY($1::uuid[])', [viaOwn]);
      assert.deepEqual(types.rows.map((row) => row.doc_type), [Q62_OWN_DOC_TYPE], `${where}: the applied filter narrowed to the own doc type`);

      const direct = await run(scopeA, `${Q62_TOKEN} register entries`, { retrievalFilters: { docTypes: [Q62_FOREIGN_DOC_TYPE] } });
      assert.deepEqual(idsOf(direct), [], `${where}: a filter on another tenant's doc type reads nothing of that tenant`);
      for (const other of others()) {
        const own = await run(await q62Scope(other), q62ChunkText(other.label, 0), { retrievalFilters: { docTypes: [Q62_FOREIGN_DOC_TYPE] } });
        assert.ok(idsOf(own).length > 0, `${where}: the owner still finds its own doc type`);
        assert.deepEqual(await keysOf(idsOf(own)), [other.key], `${where}: the owner gets only its own rows`);
      }
      if (mode === 'single-tenant') {
        const refused = await run(foreignPersonal(), Q62_QUESTION);
        assert.equal(refused.status, 'error', `${where}: a personal key is refused`);
        assert.equal(refused.candidates.length, 0);
      }
    });

    test(`RAG_TRANSLATION_GLOSSARY: the effective glossary read and the translation glossary of tenant A hold only tenant A's pair (${mode})`, async () => {
      useSwitches({ RAG_TRANSLATION_GLOSSARY: 'true' }, { adminClient: () => q62ServiceRoleRpc(db) as never });
      const where = `${mode}/translation_glossary`;
      const { loadTenantGlossary } = await import('@/lib/rag/query/glossary');
      const { glossaryFor, GlossaryUnavailable } = await import('@/lib/rag/ingest/translate/glossary');
      for (const tenant of [seed.a, ...others()]) {
        const own = Q62_GLOSSARY_TARGET[tenant.label];
        const foreign = Object.entries(Q62_GLOSSARY_TARGET).filter(([label]) => label !== tenant.label).map(([, target]) => target);
        const effective = await loadTenantGlossary(await q62Scope(tenant));
        assert.ok(effective, `${where}/${tenant.label}: the effective glossary loads`);
        assert.equal(effective.tenantKey, tenant.key);
        assert.deepEqual(effective.pairs.map((pair) => pair.target), [own], `${where}/${tenant.label}: effective pairs`);
        const translation = await glossaryFor({ tenantKey: tenant.key }, 'zh', 'en');
        assert.deepEqual(translation.terms, [{ source: Q62_GLOSSARY_SOURCE, target: own }], `${where}/${tenant.label}: translation terms`);
        for (const target of foreign) assert.ok(!JSON.stringify([effective, translation]).includes(target), `${where}/${tenant.label}: holds the other tenant's pair`);
      }
      if (mode === 'single-tenant') {
        assert.equal(await loadTenantGlossary(foreignPersonal()), null, `${where}: a personal key reads no glossary`);
        await assert.rejects(() => glossaryFor({ tenantKey: `u:${TWO_TENANT_IDS.userB}` }, 'zh', 'en'), GlossaryUnavailable, `${where}: a personal key is refused`);
      }
    });

    test(`RAG_SCOPE_GATE: tenant A's centroid snapshot and out-of-scope examples never include another tenant's (${mode})`, async () => {
      const embedded: string[] = [];
      useSwitches(
        { RAG_SCOPE_GATE: 'true' },
        {
          adminClient: () => q62ServiceRoleRpc(db) as never,
          embedder: async (text) => {
            embedded.push(text);
            return embedText(text);
          },
        },
      );
      const where = `${mode}/scope_gate`;
      const { scopeCentroidsAfterPublishOn } = await import('@/lib/rag/scope/post-publish');
      const { rebuildScopeCentroids } = await import('@/lib/rag/scope/build');
      const { centroidRefreshesSettledForTests, getCentroidSnapshot, resetCentroidCacheForTests } = await import('@/lib/rag/scope/centroids');
      const { addScopeExample, deleteScopeExample, scopeGateStatus } = await import('@/lib/rag/scope/admin');
      const { LEGACY_PROFILE } = await import('@/lib/rag/embeddings/active-profile');
      assert.equal(scopeCentroidsAfterPublishOn(), true, `${where}: the scope gate switch is effective`);
      resetCentroidCacheForTests();
      const tenants = [seed.a, ...others()];
      const examples = new Map<string, string>();
      try {
        for (const tenant of tenants) {
          const scope = await q62Scope(tenant);
          const built = await rebuildScopeCentroids(scope, { profile: LEGACY_PROFILE });
          assert.equal(built.tenantKey, tenant.key, `${where}/${tenant.label}: rebuild keyed by the caller`);
          const added = await addScopeExample(scope, { text: Q62_EXAMPLE_TEXT[tenant.label], actorId: tenant.userId ?? TWO_TENANT_IDS.userA });
          assert.ok(added.ok, `${where}/${tenant.label}: example saved (${JSON.stringify(added)})`);
          examples.set(tenant.key, added.example.id);
        }
        for (const tenant of tenants) {
          const scope = await q62Scope(tenant);
          getCentroidSnapshot(scope, LEGACY_PROFILE.id);
          await centroidRefreshesSettledForTests();
          const snapshot = getCentroidSnapshot(scope, LEGACY_PROFILE.id);
          assert.ok(snapshot, `${where}/${tenant.label}: a snapshot`);
          assert.equal(snapshot.tenantKey, tenant.key);
          const ownTypes = new Set(tenant.docTypes);
          for (const centroid of snapshot.centroids.filter((entry) => entry.kind === 'doc_type')) {
            assert.ok(ownTypes.has(centroid.key.split('/')[0]!), `${where}/${tenant.label}: centroid ${centroid.key} is not the caller's`);
          }
          const stored = await db.query<{ tenant_key: string }>('SELECT DISTINCT tenant_key FROM public.rag_scope_centroids WHERE tenant_key = $1', [tenant.key]);
          assert.deepEqual(stored.rows.map((row) => row.tenant_key), [tenant.key]);
          const status = await scopeGateStatus(scope);
          assert.ok(status.ok);
          assert.equal(status.status.examples, 1, `${where}/${tenant.label}: only its own example is counted`);
          for (const other of tenants.filter((entry) => entry !== tenant)) {
            assert.deepEqual(await deleteScopeExample(scope, examples.get(other.key)!), { ok: false, code: 'not_found' }, `${where}/${tenant.label}: cannot delete the other tenant's example`);
          }
        }
        const rows = await db.query<{ tenant_key: string; n: number }>('SELECT tenant_key, count(*)::int AS n FROM public.rag_scope_negative_examples GROUP BY tenant_key ORDER BY tenant_key');
        assert.deepEqual(rows.rows.map((row) => [row.tenant_key, row.n]), tenants.map((tenant) => [tenant.key, 1]).sort(), `${where}: one example per tenant, each under its own key`);
        if (mode === 'single-tenant') {
          await assert.rejects(() => rebuildScopeCentroids(foreignPersonal(), { profile: LEGACY_PROFILE }), `${where}: a personal key cannot build centroids`);
          const refused = await addScopeExample(foreignPersonal(), { text: 'A neutral synthetic refused question', actorId: TWO_TENANT_IDS.userB });
          assert.equal(refused.ok, false, `${where}: a personal key cannot save an example`);
        }
      } finally {
        await centroidRefreshesSettledForTests();
        await db.exec('DELETE FROM public.rag_scope_negative_examples; DELETE FROM public.rag_scope_centroids;');
        resetCentroidCacheForTests();
      }
    });

    test(`RAG_WHATSAPP_HISTORY: tenant A's owner gets only its own turns; another owner's and a second sender's are excluded (${mode})`, async () => {
      const where = `${mode}/whatsapp_history`;
      const harness = createWhatsAppHarness({
        post: () => async () => new Response('data: {"type":"text-delta","id":"t","delta":"A neutral synthetic reply."}\n\ndata: [DONE]\n\n', { status: 200 }),
      });
      const ownerA = TWO_TENANT_IDS.userA;
      const ownerB = TWO_TENANT_IDS.userB;
      const owners: Record<string, string> = { [WA_SESSION_A]: ownerA, [WA_SESSION_B]: ownerB };
      harness.deps.sessionManager = {
        async getSessionById(id: string) {
          return owners[id] ? { sessionId: id, userId: owners[id], status: 'connected' } : null;
        },
        async updateSessionStatus() {},
      };
      for (const [owner, sender] of [
        [ownerA, WA_SENDER_A],
        [ownerB, WA_SENDER_A],
        [ownerA, WA_SENDER_B],
      ] as const) {
        seedConversation(harness, sender, owner);
      }
      const saved = process.env.RAG_WHATSAPP_HISTORY;
      process.env.RAG_WHATSAPP_HISTORY = 'true';
      try {
        const { WhatsAppWebhookHandler } = await import('@/lib/whatsapp/webhook-handler');
        const handler = new WhatsAppWebhookHandler(harness.deps as never);
        const say = async (text: string, sessionId: string, from: string) => {
          await handler.handleWebhook(inboundText(text, { sessionId, from }) as never);
          settleTitles(harness);
        };
        await say('Alpha first synthetic question.', WA_SESSION_A, WA_SENDER_A);
        await say('Bravo owner synthetic question.', WA_SESSION_B, WA_SENDER_A);
        await say('Second sender synthetic question.', WA_SESSION_A, WA_SENDER_B);
        const chatA = harness.tables.whatsapp_conversations.find((row) => row.user_id === ownerA && row.whatsapp_jid === WA_SENDER_A)!.chat_id;
        const stored = harness.tables.chats.find((row) => row.id === chatA)!.messages as Array<Record<string, unknown>>;
        stored.push(
          { role: 'user', content: 'Planted turn of the other owner.', metadata: { whatsapp: { sessionId: WA_SESSION_B, senderJid: WA_SENDER_A } } },
          { role: 'user', content: 'Planted turn of the second sender.', metadata: { whatsapp: { sessionId: WA_SESSION_A, senderJid: WA_SENDER_B } } },
        );
        await say('Alpha follow-up synthetic question.', WA_SESSION_A, WA_SENDER_A);
        const last = harness.chatRequests.at(-1)!.body.messages as Array<{ content?: unknown; parts?: unknown }>;
        const sent = JSON.stringify(last);
        assert.ok(sent.includes('Alpha first synthetic question.'), `${where}: the own earlier turn is in the window (${sent.slice(0, 300)})`);
        assert.ok(sent.includes('Alpha follow-up synthetic question.'), `${where}: the current turn is last`);
        for (const foreign of ['Bravo owner synthetic question.', 'Second sender synthetic question.', 'Planted turn of the other owner.', 'Planted turn of the second sender.']) {
          assert.ok(!sent.includes(foreign), `${where}: the window holds "${foreign}"`);
        }
        const bravo = harness.chatRequests.find((request) => JSON.stringify(request.body.messages).includes('Bravo owner synthetic question.'));
        assert.ok(bravo && !JSON.stringify(bravo.body.messages).includes('Alpha'), `${where}: the other owner's request holds no tenant A turn`);
      } finally {
        if (saved === undefined) delete process.env.RAG_WHATSAPP_HISTORY;
        else process.env.RAG_WHATSAPP_HISTORY = saved;
      }
    });
  });
}
