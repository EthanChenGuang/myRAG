import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '@/lib/rag/config';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { RETRIEVAL_BACKEND_IDS, type BackendId, type BackendLegs, type RankedHit } from '@/lib/rag/backend/types';
import type { StoreLegs, VectorStore, VectorSyncTarget } from '@/lib/rag/sync/stores/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { RetrievalBackendSelection } from '@/lib/rag/types';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../../eval/harness/fake-edge.mts';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../../eval/harness/pglite-supabase.mts';

export const LEGACY_PROFILE = 'openai-3-small-1536';
export const SECOND_PROFILE = 'voyage-4-large-1024';
export const SECOND_PROFILE_DIMS = 1024;
export const CANARY_ACTOR = 'canary-suite';

/** The one sentence every tenant's canary document holds; a query for it matches every tenant on both legs. */
export const CANARY_SENTENCE = 'The amber kite drifts over the silent meadow while seven lanterns glow beside the quiet ford';

/** The local compose placeholders (docker-compose.backends.yml); CI overrides them through the environment. */
const LOCAL_KEYS: Record<string, string> = {
  QDRANT_API_KEY: 'local-qdrant-write-key-placeholder-000000',
  QDRANT_READ_API_KEY: 'local-qdrant-read-key-placeholder-0000000',
  WEAVIATE_API_KEY: 'local-weaviate-write-key-placeholder-00',
  WEAVIATE_READ_API_KEY: 'local-weaviate-read-key-placeholder-000',
};

const CI_LANGUAGES = { RAG_SUPPORTED_LANGUAGES: 'zh,en,it', RAG_PRIMARY_LANGUAGE: 'en' } as const;

/**
 * D-12, A-12: the backends this run covers. Unset means pgvector only (the default `npx vitest run`); otherwise exactly the listed
 * names, each of which must be a retrieval backend id.
 */
export function canaryBackends(env: Record<string, string | undefined> = process.env): BackendId[] {
  const raw = (env.RAG_CANARY_BACKENDS ?? '').trim();
  if (raw === '') return ['pgvector'];
  const names = raw.split(',').map((name) => name.trim());
  const out: BackendId[] = [];
  for (const name of names) {
    if (!(RETRIEVAL_BACKEND_IDS as readonly string[]).includes(name)) throw new Error(`[Canary] unknown backend in RAG_CANARY_BACKENDS: ${name}`);
    if (!out.includes(name as BackendId)) out.push(name as BackendId);
  }
  return out;
}

/** A-9: the backend-canary CI job covers exactly these; anything else fails the guard. */
export const CI_CANARY_BACKENDS: readonly BackendId[] = ['pgvector', 'weaviate', 'qdrant'];

const SERVICE_CHECKS: Record<VectorSyncTarget, { urlVar: string; path: string }> = {
  qdrant: { urlVar: 'QDRANT_URL', path: '/readyz' },
  weaviate: { urlVar: 'WEAVIATE_URL', path: '/v1/.well-known/ready' },
};

export type GuardFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * A-9, research Pitfall 10: what keeps the canary from passing by skipping. With CI_BACKEND_CANARY=1 the list must be exactly the three
 * backends, both service URLs set and both health checks answering 200. Outside CI only what RAG_CANARY_BACKENDS names is checked.
 * Returns the problems found; an empty list means the configured legs will really run.
 */
export async function canaryGuardProblems(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: GuardFetch = (url, init) => fetch(url, init),
  timeoutMs = 5_000,
): Promise<string[]> {
  const problems: string[] = [];
  const ci = env.CI_BACKEND_CANARY === '1';
  let listed: BackendId[] = [];
  try {
    listed = canaryBackends(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (ci) {
    const exact = listed.length === CI_CANARY_BACKENDS.length && CI_CANARY_BACKENDS.every((id) => listed.includes(id));
    if (!exact) problems.push(`RAG_CANARY_BACKENDS must be exactly ${CI_CANARY_BACKENDS.join(',')} in the backend-canary job (got "${env.RAG_CANARY_BACKENDS ?? ''}")`);
  }
  const targets = (ci ? (['weaviate', 'qdrant'] as VectorSyncTarget[]) : listed.filter(isExternalBackend)).sort();
  for (const target of targets) {
    const { urlVar, path } = SERVICE_CHECKS[target];
    const base = (env[urlVar] ?? '').trim();
    if (base === '') {
      problems.push(`${urlVar} is not set for the ${target} canary leg`);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base.replace(/\/+$/, '')}${path}`, { signal: controller.signal });
      if (response.status !== 200) problems.push(`${target} health check ${path} answered ${response.status}`);
    } catch (error) {
      problems.push(`${target} health check ${path} failed (${error instanceof Error ? error.name : 'error'})`);
    } finally {
      clearTimeout(timer);
    }
  }
  return problems;
}

export function isExternalBackend(id: BackendId): id is VectorSyncTarget {
  return id === 'qdrant' || id === 'weaviate';
}

export type CanaryLabel = 'a' | 'b' | 'o' | 'm' | 's';

export interface CanaryTenant {
  label: CanaryLabel;
  scope: TenantScope;
  tenantKey: string;
  userId: string | null;
  organizationId: string | null;
  /** The word only this tenant's canary document holds. */
  marker: string;
  documentId: string;
  chunkIds: string[];
}

export interface CanarySearchOptions {
  profileId?: string;
  denseLimit?: number;
  lexicalLimit?: number;
}

export interface CanarySearchResult {
  legs: BackendLegs;
  selection: RetrievalBackendSelection;
  /** Both legs, in leg order. */
  hits: RankedHit[];
}

export interface CanaryEnv {
  backend: BackendId;
  mode: DeploymentMode;
  db: PGlite;
  edge: FakeEdge;
  client: RpcClient;
  /** Random per environment, so concurrent files never share a partition of a live service. */
  nonce: string;
  ids: { userA: string; userB: string; userM: string; orgO: string };
  /** Seeded tenants: a, b, o (document written by member m) and m (personal, no documents) in multi-tenant mode; s in single-tenant mode. */
  tenants: Partial<Record<CanaryLabel, CanaryTenant>>;
  /** Every tenant key the environment wrote; close() removes their partitions from a live store. */
  tenantKeys: Set<string>;
  /** The write-key handle of the external store; null on pgvector. */
  store: VectorStore | null;
  /** The production selection path: resolveRetrievalBackend with the chat profile and RAG_RETRIEVAL_BACKEND set to the backend under test. */
  search(scope: TenantScope, query: string, options?: CanarySearchOptions): Promise<CanarySearchResult>;
  /** The store's own scoped search over the write handle, without re-validation (the foreign-point control). */
  rawStoreSearch(scope: TenantScope, query: string, options?: CanarySearchOptions): Promise<StoreLegs>;
  queryVector(query: string, profileId?: string): number[];
  drain(): Promise<void>;
  reconcile(): Promise<void>;
  /** Drains, then reconciles until every (target, profile, tenant) row is ready; a no-op on pgvector. */
  settle(): Promise<void>;
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface CreateCanaryEnvOptions {
  /** Default true: seeds the tenants' canary documents through ingest. */
  seed?: boolean;
}

function lowerUuid(): string {
  return crypto.randomUUID().toLowerCase();
}

function letters(bytes: number): string {
  return [...crypto.randomBytes(bytes)].map((byte) => String.fromCharCode(97 + (byte % 26))).join('');
}

/** A query vector for a profile: the fixture embedder at the profile's dims (the second profile's fake provider uses the same). */
export function canaryVector(text: string, profileId: string = LEGACY_PROFILE): number[] {
  return profileId === SECOND_PROFILE ? embedText(text, SECOND_PROFILE_DIMS) : embedText(text);
}

async function rpcCall(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new Error(`[Canary] ${fn} failed (${response.error.code ?? 'rpc_error'}: ${response.error.message ?? ''})`);
  return response.data;
}

async function buildStore(backend: VectorSyncTarget): Promise<VectorStore> {
  if (backend === 'qdrant') {
    const [{ createQdrantStore }, { getQdrantWriteClient }] = await Promise.all([import('@/lib/rag/sync/stores/qdrant'), import('@/lib/rag/backend/qdrant/client')]);
    return createQdrantStore({ writeClient: getQdrantWriteClient() });
  }
  const [{ createWeaviateStore }, { getWeaviateWriteClient }] = await Promise.all([import('@/lib/rag/sync/stores/weaviate'), import('@/lib/rag/backend/weaviate/client')]);
  return createWeaviateStore({ client: await getWeaviateWriteClient() });
}

function stubEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * D-12, A-12: one canary environment. The PGlite fixture runs in the given deployment mode behind the fake edge; the target under test
 * is enabled before any row is written; the tenants' documents go through ingest(), the outbox and the drain; reconcile marks every
 * tenant ready; retrieval goes through resolveRetrievalBackend with an injected config (RAG_PIPELINE=v2, RAG_RETRIEVAL_BACKEND set to
 * the backend under test), never through process-wide configuration.
 */
export async function createCanaryEnv(backend: BackendId, mode: DeploymentMode, options: CreateCanaryEnvOptions = {}): Promise<CanaryEnv> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true });
  const edge = await startFakeEdge({ db });
  const external = isExternalBackend(backend) ? backend : null;
  const keyDefaults: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(LOCAL_KEYS)) keyDefaults[name] = process.env[name] || value;
  const restoreEnv = stubEnv({
    ...fixtureProcessEnv(edge.url),
    ...CI_LANGUAGES,
    ...keyDefaults,
    NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: mode,
    MYRAG_DEPLOYMENT_MODE: mode,
  });
  const serviceKey = fixtureProcessEnv(edge.url).SUPABASE_SERVICE_ROLE_KEY as string;
  const supabase = createClient(edge.url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }) as SupabaseClient;
  const client = supabase as unknown as RpcClient;

  const [deps, factoryModule, readinessModule, registryModule, settingsModule, configModule, drainModule, reconcileModule, ingestFakes, embeddingRegistry] =
    await Promise.all([
      import('@/lib/rag/deps'),
      import('@/lib/rag/backend/factory'),
      import('@/lib/rag/backend/readiness'),
      import('@/lib/rag/backend/registry'),
      import('@/lib/rag/lang/settings'),
      import('@/lib/rag/config'),
      import('@/lib/rag/sync/drain'),
      import('@/lib/rag/sync/reconcile'),
      import('../../../eval/harness/ingest-fakes.mts'),
      import('@/lib/rag/embeddings/registry'),
    ]);
  settingsModule.resetLanguageSettingsForTests();
  configModule.resetRagConfigForTests();
  registryModule.resetRetrievalBackendForTests();
  factoryModule.resetBackendFactoryForTests();
  readinessModule.resetReadinessCacheForTests();
  if (external === 'qdrant') (await import('@/lib/rag/backend/qdrant/client')).resetQdrantClientsForTests();
  if (external === 'weaviate') (await import('@/lib/rag/backend/weaviate/client')).resetWeaviateClientsForTests();
  deps.setRagDepsForTests({ adminClient: () => supabase, embedder: async (text) => embedText(text) });
  const fakes = await ingestFakes.installIngestFakes({
    db: client,
    env: { ...ingestFakes.INGEST_MODE_ENV, RAG_INJECTION_SCAN: 'quarantine' },
  });

  const nonce = letters(6);
  const ids = { userA: lowerUuid(), userB: lowerUuid(), userM: lowerUuid(), orgO: lowerUuid() };
  const tenantKeys = new Set<string>();
  let store: VectorStore | null = null;
  const backendConfig: BackendConfig = { default: backend, voice: 'pgvector', maxLagSeconds: 300 };

  const drain = async () => {
    if (!store) return;
    const reports = await drainModule.drainUntilEmpty({ store, rpc: client, budgetMs: 60_000, batch: 100, trace: false, sink: () => undefined, maxSlices: 50 });
    const failed = reports.reduce((n, report) => n + report.failed + report.dead, 0);
    if (failed > 0) throw new Error(`[Canary] ${failed} outbox rows failed to drain`);
    readinessModule.resetReadinessCacheForTests();
  };

  const notReady = async (): Promise<number> => {
    if (!external) return 0;
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.rag_backend_index_state WHERE target = $1 AND state <> 'ready'`,
      [external],
    );
    return Number(rows.rows[0]?.n ?? 0);
  };

  const reconcile = async () => {
    if (!store) return;
    await reconcileModule.reconcileSlice({ stores: [store], rpc: client, budgetMs: 60_000, trace: false, sink: () => undefined });
    readinessModule.resetReadinessCacheForTests();
  };

  const settle = async () => {
    if (!store) return;
    for (let round = 0; round < 5; round += 1) {
      await drain();
      await reconcile();
      if ((await notReady()) === 0) return;
    }
    throw new Error('[Canary] reconcile did not mark every tenant ready');
  };

  const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(text, params)).rows;

  const env: CanaryEnv = {
    backend,
    mode,
    db,
    edge,
    client,
    nonce,
    ids,
    tenants: {},
    tenantKeys,
    store: null,
    async search(scope, query, searchOptions = {}) {
      const profileId = searchOptions.profileId ?? LEGACY_PROFILE;
      const resolved = factoryModule.resolveRetrievalBackend('chat', { pipeline: 'v2', backend: backendConfig }, undefined, {
        readinessRpc: client,
      });
      const { queryLexicalTokens } = await import('@/lib/rag/lexical/tokenize');
      const legs = await resolved.backend.search({
        scope,
        embeddingProfileId: profileId,
        denseVector: canaryVector(query, profileId),
        lexicalTokens: queryLexicalTokens(query),
        lexicalLanguages: null,
        access: { mode: 'off' },
        filters: { currentOnly: true },
        denseLimit: searchOptions.denseLimit ?? 50,
        lexicalLimit: searchOptions.lexicalLimit ?? 50,
        signal: new AbortController().signal,
      });
      return { legs, selection: resolved.selection(), hits: [...legs.dense, ...legs.lexical] };
    },
    async rawStoreSearch(scope, query, searchOptions = {}) {
      if (!store) throw new Error('[Canary] pgvector has no external store');
      const profileId = searchOptions.profileId ?? LEGACY_PROFILE;
      const { queryLexicalTokens } = await import('@/lib/rag/lexical/tokenize');
      return store.searchLegs({
        scope,
        profileId,
        denseVector: canaryVector(query, profileId),
        lexicalTokens: queryLexicalTokens(query),
        denseLimit: searchOptions.denseLimit ?? 50,
        lexicalLimit: searchOptions.lexicalLimit ?? 50,
        filters: { currentOnly: true },
        signal: new AbortController().signal,
      });
    },
    queryVector: canaryVector,
    drain,
    reconcile,
    settle,
    sql,
    async close() {
      const live = store;
      if (live) {
        for (const profile of [LEGACY_PROFILE, SECOND_PROFILE]) {
          for (const key of tenantKeys) await live.deleteTenant(profile, key).catch(() => undefined);
        }
      }
      embeddingRegistry.resetEmbeddingProvidersForTests();
      await fakes.uninstall();
      deps.resetRagDepsForTests();
      factoryModule.resetBackendFactoryForTests();
      registryModule.resetRetrievalBackendForTests();
      readinessModule.resetReadinessCacheForTests();
      await edge.close();
      await db.close();
      restoreEnv();
      settingsModule.resetLanguageSettingsForTests();
      configModule.resetRagConfigForTests();
    },
  };

  try {
    if (external) {
      store = await buildStore(external);
      env.store = store;
      await rpcCall(client, 'rag_vector_sync_set_target', { p_target: external, p_enabled: true, p_actor: CANARY_ACTOR });
    }
    const { seedCanaryIdentities, seedCanaryTenants } = await import('./seed');
    await seedCanaryIdentities(env);
    if (options.seed !== false) {
      await seedCanaryTenants(env);
      await settle();
    }
    return env;
  } catch (error) {
    await env.close().catch(() => undefined);
    throw error;
  }
}

/** Every marker of the environment's tenants except the given one's. */
export function foreignMarkers(env: CanaryEnv, own: CanaryLabel | CanaryLabel[]): string[] {
  const mine = new Set(Array.isArray(own) ? own : [own]);
  return Object.values(env.tenants)
    .filter((tenant): tenant is CanaryTenant => tenant !== undefined && !mine.has(tenant.label))
    .map((tenant) => tenant.marker);
}

/** Hits whose content carries any of the given markers, or whose chunk id is one of the given ids. */
export function leaked(hits: RankedHit[], markers: string[], chunkIds: string[] = []): RankedHit[] {
  const ids = new Set(chunkIds);
  return hits.filter((hit) => ids.has(hit.chunkId) || markers.some((marker) => hit.content.includes(marker)));
}
