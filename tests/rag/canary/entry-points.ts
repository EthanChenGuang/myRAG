import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendId } from '@/lib/rag/backend/types';
import type { QdrantApi } from '@/lib/rag/backend/qdrant/client';
import type { WeaviateClientLike, WeaviateCollectionHandle, WeaviateQueryResult, WeaviateTenantCollection } from '@/lib/rag/backend/weaviate/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { RetrievalResult } from '@/lib/rag/types';
import type { CanaryEnv, CanaryTenant } from './factory';

/** A generated placeholder for the voice token secret (64 hex characters, above MIN_VOICE_SECRET_LENGTH); never a real secret. */
export const CANARY_VOICE_SECRET = crypto.randomBytes(32).toString('hex');

/** The two backend switches of one request; undefined means the variable is unset (its default, pgvector). */
export interface EntryConfig {
  backend?: BackendId;
  voiceBackend?: BackendId;
}

export interface EntrySelection {
  backend: string;
  fallbackReason: string | null;
  tenantValidationDropped: number;
  degraded: boolean;
  /** Hits per leg as the search stage counted them. */
  legs: { dense: number; lexical: number };
}

export interface EntryOutcome {
  /** Set when the entry point refused the request before retrieval; result is then null. */
  refused: { status: number | string; reason: string } | null;
  scope: TenantScope | null;
  result: RetrievalResult | null;
  /** The search stage's backend fields, read from its trace record. */
  selection: EntrySelection | null;
  /** Candidate chunk ids and contents, in result order. */
  ids: string[];
  contents: string[];
  /** Every admin RPC name the request called, in order. */
  rpcCalls: string[];
}

export interface VoiceRequestOptions {
  /** Sent instead of a token minted for the tenant (tampered or foreign tokens). */
  token?: string;
  secret?: string;
}

function recordingClient(inner: SupabaseClient | null, calls: string[]): SupabaseClient | null {
  if (!inner) return null;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (fn: string, args?: unknown, options?: unknown) => {
          calls.push(fn);
          return (target.rpc as (...a: unknown[]) => unknown).call(target, fn, args, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Runs one retrieval with the request's backend switches injected through the dependency seam (RAG_PIPELINE=v2, lexical search on),
 * never through process-wide configuration, and restores the previous dependencies afterwards.
 */
async function withEntryConfig<T>(config: EntryConfig, run: (calls: string[]) => Promise<T>): Promise<T> {
  const deps = await import('@/lib/rag/deps');
  const current = deps.getRagDeps();
  const previous = { ragEnv: current.ragEnv, rawPipelineEnv: current.rawPipelineEnv, adminClient: current.adminClient };
  const baseEnv = current.ragEnv();
  const calls: string[] = [];
  deps.setRagDepsForTests({
    ragEnv: () => ({
      ...baseEnv,
      RAG_PIPELINE: 'v2',
      pipelineSourceHint: 'explicit',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_RETRIEVAL_BACKEND: config.backend,
      RAG_RETRIEVAL_BACKEND_VOICE: config.voiceBackend,
    }),
    rawPipelineEnv: () => ({ RAG_PIPELINE: 'v2' }),
    adminClient: () => recordingClient(previous.adminClient(), calls),
  });
  try {
    return await run(calls);
  } finally {
    deps.setRagDepsForTests(previous);
  }
}

function selectionOf(result: RetrievalResult): EntrySelection | null {
  const search = result.stages.find((stage) => stage.name === 'search');
  const attributes = search?.attributes;
  if (!attributes || typeof attributes.backend !== 'string') return null;
  return {
    backend: attributes.backend,
    fallbackReason: typeof attributes.fallback_reason === 'string' ? attributes.fallback_reason : null,
    tenantValidationDropped: Number(attributes.tenant_validation_dropped ?? 0),
    degraded: search?.status === 'degraded',
    legs: { dense: Number(search?.counts?.dense ?? 0), lexical: Number(search?.counts?.lexical ?? 0) },
  };
}

async function retrieve(
  scope: TenantScope,
  profile: 'voice' | 'embed' | 'chat',
  question: string,
  config: EntryConfig,
  extra: { channel?: 'embed' } = {},
): Promise<Omit<EntryOutcome, 'refused'>> {
  const { runRetrieval } = await import('@/lib/rag/pipeline');
  return withEntryConfig(config, async (calls) => {
    const result = await runRetrieval({ scope, query: question, profile, signal: new AbortController().signal, ...extra });
    return {
      scope,
      result,
      selection: selectionOf(result),
      ...answered(result),
      rpcCalls: [...calls],
    };
  });
}

/** What the entry point hands on: the candidates and, for voice, the voice results the agent receives; each chunk once. */
function answered(result: RetrievalResult): { ids: string[]; contents: string[] } {
  const rows = [...result.candidates, ...(result.voice?.results ?? [])];
  const ids: string[] = [];
  const contents: string[] = [];
  for (const row of rows) {
    const id = String(row.chunk_id);
    if (ids.includes(id)) continue;
    ids.push(id);
    contents.push(row.content);
  }
  return { ids, contents };
}

function refusedOutcome(status: number | string, reason: string): EntryOutcome {
  return { refused: { status, reason }, scope: null, result: null, selection: null, ids: [], contents: [], rpcCalls: [] };
}

/** A voice token for a canary tenant: the scope's own key, the member as actor for a single-tenant scope that names no user. */
export async function mintCanaryVoiceToken(scope: TenantScope, secret: string = CANARY_VOICE_SECRET): Promise<string> {
  const { mintVoiceToken } = await import('@/lib/rag/tenant/voice-token');
  const minted = mintVoiceToken({ scope, secret, ttlSeconds: 600 });
  if (!minted.ok) throw new Error(`[Canary] voice token not minted (${minted.reason})`);
  return minted.token;
}

/**
 * The voice entry point (D-12): a token minted for the tenant with the test secret, the scope resolved only by resolveVoiceScope from
 * the x-rag-scope-token header (membership re-checked), then runRetrieval with the voice profile and the injected backend switches.
 */
export async function voiceRequest(
  env: CanaryEnv,
  tenant: Pick<CanaryTenant, 'scope'>,
  question: string,
  config: EntryConfig,
  options: VoiceRequestOptions = {},
): Promise<EntryOutcome> {
  const { resolveVoiceScope, VOICE_SCOPE_HEADER } = await import('@/lib/rag/tenant/voice');
  const secret = options.secret ?? CANARY_VOICE_SECRET;
  const token = options.token ?? (await mintCanaryVoiceToken(tenant.scope, secret));
  const headers = new Headers({ [VOICE_SCOPE_HEADER]: token });
  const resolved = await resolveVoiceScope({ headers, secret: CANARY_VOICE_SECRET, deploymentMode: env.mode, signal: new AbortController().signal });
  if (!resolved.ok) return refusedOutcome(resolved.status, resolved.reason);
  return { refused: null, ...(await retrieve(resolved.scope, 'voice', question, config)) };
}

/**
 * The embed entry point (D-12, Phase 2 embed rule): the tenant comes only from the configured RAG_EMBED_TENANT value; the raw body is
 * inspected by resolveEmbedScope and never supplies a scope. Retrieval runs with the embed profile and channel.
 */
export async function embedRequest(
  env: CanaryEnv,
  configuredTenant: string | undefined,
  rawBody: unknown,
  question: string,
  config: EntryConfig,
): Promise<EntryOutcome> {
  const { resolveEmbedScope, resetEmbedTenantLogForTests } = await import('@/lib/rag/tenant/embed');
  resetEmbedTenantLogForTests();
  const resolved = await resolveEmbedScope({ rawBody, configuredTenant, deploymentMode: env.mode, signal: new AbortController().signal });
  if (!resolved.ok) return refusedOutcome(resolved.status, resolved.reason);
  return { refused: null, ...(await retrieve(resolved.scope, 'embed', question, config, { channel: 'embed' })) };
}

/**
 * 07-39: one retrieval for a scope an entry point already resolved (tenant and, while RAG_DOC_ACCESS_GROUPS is on, access through
 * resolveAccessScope as the routes do), through the same seam as the drivers above.
 */
export async function resolvedRequest(
  scope: TenantScope,
  profile: 'voice' | 'embed' | 'chat',
  question: string,
  config: EntryConfig,
): Promise<EntryOutcome> {
  return { refused: null, ...(await retrieve(scope, profile, question, config, profile === 'embed' ? { channel: 'embed' } : {})) };
}

/** The chat profile through the same seam, for the selection comparison with voice. */
export async function chatRequest(scope: TenantScope, question: string, config: EntryConfig): Promise<EntryOutcome> {
  return { refused: null, ...(await retrieve(scope, 'chat', question, config)) };
}

export interface FilterIgnoringReader<T> {
  client: T;
  /** Every point id the vendor answered, before re-validation (the control). */
  rawIds(): Set<string>;
  reset(): void;
}

/** A proxy that answers the given properties and forwards everything else to the target (methods bound to it). */
function override<T extends object>(target: T, replaced: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(object, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(replaced, prop)) return (replaced as Record<PropertyKey, unknown>)[prop];
      const value = Reflect.get(object, prop, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

function isTenantCondition(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { key?: unknown }).key === 'tenant_key';
}

/** Removes every tenant_key condition from a scoped Qdrant request (top filters, prefetch filters and idf corpora). */
function stripTenantClauses(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !isTenantCondition(item)).map(stripTenantClauses);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'must' && isTenantCondition(child)) continue;
    out[key] = stripTenantClauses(child);
  }
  return out;
}

/**
 * Test-only negative control for Qdrant: wraps the vendor read client so the batch qdrantScopedBatch built reaches the server with its
 * tenant clauses stripped, as a store that ignores the filter would answer. Everything above the vendor client runs as in production.
 */
export function filterIgnoringQdrant(inner: QdrantApi): FilterIgnoringReader<QdrantApi> {
  const seen = new Set<string>();
  const client = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'queryBatch') {
        return async (collection: string, batch: unknown) => {
          const stripped = stripTenantClauses(batch) as Parameters<QdrantApi['queryBatch']>[1];
          const responses = await target.queryBatch(collection, stripped);
          for (const response of responses) for (const point of response.points ?? []) seen.add(String(point.id));
          return responses;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { client, rawIds: () => new Set(seen), reset: () => seen.clear() };
}

/**
 * Test-only negative control for Weaviate: wraps the vendor client so every tenant handle answers from the given foreign tenant's shard,
 * whatever tenant the adapter asked for. tenantCollection and searchWeaviateLegs run as in production.
 */
export function filterIgnoringWeaviate(inner: WeaviateClientLike, foreignTenantName: string): FilterIgnoringReader<WeaviateClientLike> {
  const seen = new Set<string>();
  const record = (result: WeaviateQueryResult): WeaviateQueryResult => {
    for (const object of result.objects ?? []) if (typeof object.uuid === 'string') seen.add(object.uuid);
    return result;
  };
  const tenantHandle = (handle: WeaviateCollectionHandle): WeaviateTenantCollection => {
    const foreign = handle.withTenant(foreignTenantName);
    const query = override(foreign.query, {
      nearVector: async (...args: Parameters<WeaviateTenantCollection['query']['nearVector']>) => record(await foreign.query.nearVector(...args)),
      bm25: async (...args: Parameters<WeaviateTenantCollection['query']['bm25']>) => record(await foreign.query.bm25(...args)),
    });
    return override(foreign, { query });
  };
  const collections = override(inner.collections, {
    use: (name: string) => {
      const handle = inner.collections.use(name);
      return override(handle, { withTenant: () => tenantHandle(handle) });
    },
  });
  return { client: override(inner, { collections }), rawIds: () => new Set(seen), reset: () => seen.clear() };
}

/**
 * The reader-level negative control (D-10): the production read client wrapped so the tenant filter is ignored (Qdrant: tenant clauses
 * stripped; Weaviate: the tenant handle answers from the foreign tenant's shard). The wrapped client is installed with
 * setExternalBackendForTests as the backend the factory would build, with re-validation through the environment's admin client.
 */
export async function filterIgnoringReader(
  env: CanaryEnv,
  foreign: Pick<CanaryTenant, 'tenantKey'>,
): Promise<FilterIgnoringReader<unknown> & { uninstall(): void }> {
  const { setExternalBackendForTests } = await import('@/lib/rag/backend/factory');
  const { getRagDeps } = await import('@/lib/rag/deps');
  const admin = () => getRagDeps().adminClient() as unknown as RpcClient | null;
  if (env.backend === 'qdrant') {
    const [{ createQdrantBackend }, { getQdrantReadClient }] = await Promise.all([import('@/lib/rag/backend/qdrant/adapter'), import('@/lib/rag/backend/qdrant/client')]);
    const wrapped = filterIgnoringQdrant(getQdrantReadClient());
    setExternalBackendForTests('qdrant', createQdrantBackend({ readClient: wrapped.client, adminClient: admin }));
    return { ...wrapped, uninstall: () => setExternalBackendForTests('qdrant', null) };
  }
  if (env.backend === 'weaviate') {
    const [{ createWeaviateBackend }, { getWeaviateReadClient }, { weaviateTenantName }] = await Promise.all([
      import('@/lib/rag/backend/weaviate/adapter'),
      import('@/lib/rag/backend/weaviate/client'),
      import('@/lib/rag/backend/tenant-key'),
    ]);
    const wrapped = filterIgnoringWeaviate(await getWeaviateReadClient(), weaviateTenantName(foreign.tenantKey));
    setExternalBackendForTests('weaviate', createWeaviateBackend({ readClient: wrapped.client, revalidate: admin }));
    return { ...wrapped, uninstall: () => setExternalBackendForTests('weaviate', null) };
  }
  throw new Error('[Canary] filterIgnoringReader wraps an external read client; pgvector uses filterIgnoringRpc');
}

/**
 * Test-only negative control for pgvector: an RPC client whose hybrid_search_chunks ignores the requested tenant and searches the
 * foreign tenant's rows instead; every other call passes through.
 */
export function filterIgnoringRpc(inner: RpcClient, foreignTenantKey: string): FilterIgnoringReader<RpcClient> {
  const seen = new Set<string>();
  const client: RpcClient = {
    rpc(fn, args) {
      if (fn !== 'hybrid_search_chunks') return inner.rpc(fn, args);
      const rewritten = { ...(args as Record<string, unknown>), p_tenant_key: foreignTenantKey };
      let signal: AbortSignal | undefined;
      const run = (): Promise<RpcResponse> => {
        const request = inner.rpc(fn, rewritten);
        return Promise.resolve(signal ? request.abortSignal(signal) : request).then((response) => {
          for (const row of (response.data ?? []) as Array<{ chunk_id?: unknown }>) if (row.chunk_id !== undefined) seen.add(String(row.chunk_id));
          return response;
        });
      };
      const request: RpcRequest = {
        abortSignal(next) {
          signal = next;
          return request;
        },
        then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
      };
      return request;
    },
  } as RpcClient;
  return { client, rawIds: () => new Set(seen), reset: () => seen.clear() };
}
