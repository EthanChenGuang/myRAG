import OpenAI from 'openai';
import { env as loadedEnv } from '@/lib/env';
import { ProviderTestResultSchema } from '@/lib/rag-eval/contracts.generated';
import { describeQdrantCollection } from '../backend/qdrant/collection';
import { buildQdrantClients, type QdrantApi } from '../backend/qdrant/client';
import { qdrantHealth } from '../backend/qdrant/adapter';
import { qdrantErrorStatus } from '../backend/qdrant/errors';
import { describeWeaviateCollection } from '../backend/weaviate/collection';
import { mapWeaviateError } from '../backend/weaviate/errors';
import { getWeaviateReadClient, resolveWeaviateConnection } from '../backend/weaviate/client';
import type { WeaviateClientLike } from '../backend/weaviate/types';
import { BackendNotReadyError } from '../backend/external';
import { RetrievalBackendError } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { getActiveProfile } from '../embeddings/active-profile';
import { createBgeM3Provider } from '../embeddings/bge-m3';
import { openAiEmbeddingsClientOptions, openAiEmbeddingsVia } from '../embeddings/openai-client';
import { createOpenAiProvider, type OpenAiEmbeddingsClient } from '../embeddings/openai-provider';
import { BGE_M3_NATIVE_DIMS, EmbeddingProviderError, OPENAI_NATIVE_DIMS } from '../embeddings/types';
import { createVoyageProvider } from '../embeddings/voyage';
import { readGenerationConfig } from '../generation/config';
import { LLAMA_CLOUD_API_BASE } from '../ingest/parsers/llamaparse-v2';
import { createCohereReranker } from '../rerank/cohere';
import { RerankError } from '../rerank/scores';
import { createVoyageReranker } from '../rerank/voyage';
import { readSecurityConfig } from '../security/config';
import { loadInjectionDetectorConfig } from '../security/detectors';
import { createLakeraDetector } from '../security/lakera';
import type { TenantScope } from '../tenant/scope';
import { readLangfuseConfig } from '../trace/config';

/**
 * D-15 (ADM-01): Test-connection probes. Each probe runs the smallest authenticated call through the app's own adapter with the
 * configuration this process loaded. A result carries only the provider id, a code, a fixed message for that code and the latency:
 * never a key, a URL, a host, a port or anything a vendor sent. Caught errors are mapped to a code and then dropped.
 */

/** Stable contract: the Config UI maps manifest providers to these ids (07-UI-SPEC 6.2.4). Additions only. */
export const PROVIDER_IDS = [
  'embedding:openai',
  'embedding:voyage',
  'embedding:deepinfra',
  'rerank:cohere',
  'rerank:voyage',
  'backend:weaviate',
  'backend:qdrant',
  'sidecar',
  'langfuse',
  'vectara',
  'lakera',
  'llamacloud',
  'anthropic',
  'exa',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Stable contract: the first five failure codes are worded by the Config UI (07-UI-SPEC 8.3); any other code is an addition. */
export const PROVIDER_PROBE_CODES = [
  'not_configured',
  'unauthorized',
  'timeout',
  'unreachable',
  'collection_missing',
  'ok',
  'disabled',
  'invalid_config',
  'rate_limited',
  'provider_error',
  'bad_response',
] as const;

export type ProviderProbeCode = (typeof PROVIDER_PROBE_CODES)[number];

/** The only text a result carries; never interpolated. */
export const PROVIDER_PROBE_MESSAGES: Readonly<Record<ProviderProbeCode, string>> = Object.freeze({
  ok: 'Connected.',
  not_configured: 'Not tested: the running app has no key or URL for this provider.',
  unauthorized: 'The provider refused the key.',
  timeout: 'No answer within 10 seconds.',
  unreachable: 'The provider could not be reached.',
  collection_missing: 'Connected, but the collection for the active embedding profile does not exist yet.',
  disabled: 'Not tested: calls to this provider are turned off in the running app.',
  invalid_config: 'Not tested: the running app has an invalid setting for this provider.',
  rate_limited: 'The provider is rate limiting requests.',
  provider_error: 'The provider answered with an error.',
  bad_response: 'The provider answered with an unexpected response.',
});

export const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

export interface ProviderProbeResult {
  provider: ProviderId;
  ok: boolean;
  latencyMs: number;
  code: ProviderProbeCode;
  message: string;
}

export type ProbeEnv = Record<string, string | undefined>;

export interface ProviderProbeDeps {
  /** The loaded configuration; defaults to the process's env snapshot. */
  env: ProbeEnv;
  fetch: typeof fetch;
  now: () => number;
  activeProfileId: () => Promise<string>;
  /** Builds the Qdrant read client from the loaded URL and read key. */
  qdrantReadClient: (source: ProbeEnv) => QdrantApi;
  /** The Weaviate read client of this process. */
  weaviateReadClient: () => Promise<WeaviateClientLike>;
}

export interface RunProviderProbeOptions {
  signal: AbortSignal;
  deps?: Partial<ProviderProbeDeps>;
}

class ProbeFailure extends Error {
  constructor(readonly code: Exclude<ProviderProbeCode, 'ok'>) {
    super(code);
    this.name = 'ProbeFailure';
  }
}

function fail(code: Exclude<ProviderProbeCode, 'ok'>): never {
  throw new ProbeFailure(code);
}

function value(source: ProbeEnv, name: string): string {
  return (source[name] ?? '').trim();
}

function requireValues(source: ProbeEnv, ...names: string[]): void {
  for (const name of names) if (value(source, name) === '') fail('not_configured');
}

function codeForStatus(status: number): Exclude<ProviderProbeCode, 'ok'> {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

function statusField(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

interface ProbeContext {
  source: ProbeEnv;
  signal: AbortSignal;
  deps: ProviderProbeDeps;
  /** The deps fetch, with a thrown error (its message can name the address) replaced by a code. */
  fetch: typeof fetch;
}

function guardedFetch(deps: ProviderProbeDeps, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    try {
      return await deps.fetch(input, init);
    } catch {
      throw new ProbeFailure(signal.aborted ? 'timeout' : 'unreachable');
    }
  };
}

/** A fetch that only fails with a code: the response body of a non-2xx answer is discarded, never read. */
async function request(ctx: ProbeContext, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await ctx.fetch(url, { ...init, signal: ctx.signal, redirect: 'error' });
  } catch {
    fail(ctx.signal.aborted ? 'timeout' : 'unreachable');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    fail(codeForStatus(response.status));
  }
  return response;
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Maps an adapter error to a code; everything about the error itself is dropped. */
function codeForError(error: unknown, signal: AbortSignal): Exclude<ProviderProbeCode, 'ok'> {
  if (error instanceof ProbeFailure) return error.code;
  if (signal.aborted) return 'timeout';
  if (error instanceof EmbeddingProviderError) return error.status === undefined ? 'unreachable' : codeForStatus(error.status);
  if (error instanceof RerankError) return codeForStatus(error.status);
  if (error instanceof BackendNotReadyError) return error.reason === 'collection_missing' ? 'collection_missing' : 'provider_error';
  if (error instanceof RetrievalBackendError) return error.code === 'permission_denied' ? 'unauthorized' : 'unreachable';
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError' || name === 'APIUserAbortError' || name === 'APIConnectionTimeoutError') {
    return 'timeout';
  }
  if (name === 'APIConnectionError') return 'unreachable';
  const status = statusField(error);
  if (status !== null) return codeForStatus(status);
  return 'bad_response';
}

function openAiClient(ctx: ProbeContext, options: { apiKey: string | undefined; baseURL?: string }): OpenAiEmbeddingsClient {
  return new OpenAI({
    ...options,
    fetch: ctx.fetch as never,
    maxRetries: 0,
    timeout: PROVIDER_PROBE_TIMEOUT_MS,
  }) as unknown as OpenAiEmbeddingsClient;
}

const PROBE_TEXT = 'ok';
const RERANK_DOCUMENTS = ['a', 'b'];
/** The fast-tier models of the rerank selection: the cheapest model the app sends to each vendor. */
const COHERE_PROBE_MODEL = 'rerank-v5.0-fast';
const VOYAGE_PROBE_MODEL = 'rerank-3-lite';
const SIDECAR_SECRET_HEADER = 'x-sidecar-secret';
const SIDECAR_PROVIDER_TEST_PATH = '/v1/providers/test';
const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const ANTHROPIC_VERSION = '2023-06-01';

async function probeOpenAiEmbedding(ctx: ProbeContext): Promise<void> {
  const via = openAiEmbeddingsVia(ctx.source);
  requireValues(ctx.source, via === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY');
  const options = openAiEmbeddingsClientOptions(ctx.source);
  const client = openAiClient(ctx, options);
  const provider = createOpenAiProvider({ client: () => client });
  await provider.embedQuery(PROBE_TEXT, { dims: OPENAI_NATIVE_DIMS, signal: ctx.signal });
}

async function probeVoyageEmbedding(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'VOYAGE_API_KEY', 'VOYAGE_BASE_URL');
  const provider = createVoyageProvider({
    config: () => ({ apiKey: value(ctx.source, 'VOYAGE_API_KEY'), baseUrl: value(ctx.source, 'VOYAGE_BASE_URL'), timeoutMs: PROVIDER_PROBE_TIMEOUT_MS }),
  });
  const dims = provider.supportedDims.includes(1024) ? 1024 : provider.supportedDims[0];
  await provider.embedQuery(PROBE_TEXT, { dims, signal: ctx.signal });
}

async function probeDeepInfraEmbedding(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'DEEPINFRA_API_KEY', 'DEEPINFRA_BASE_URL');
  const provider = createBgeM3Provider({
    config: () => ({ apiKey: value(ctx.source, 'DEEPINFRA_API_KEY'), baseUrl: value(ctx.source, 'DEEPINFRA_BASE_URL'), timeoutMs: PROVIDER_PROBE_TIMEOUT_MS }),
    serving: () => 'hosted',
    fetch: ctx.fetch,
  });
  await provider.embedQuery(PROBE_TEXT, { dims: BGE_M3_NATIVE_DIMS, signal: ctx.signal });
}

async function probeCohereRerank(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'COHERE_API_KEY');
  const reranker = createCohereReranker({
    fetch: ctx.fetch,
    apiKey: value(ctx.source, 'COHERE_API_KEY'),
    baseUrl: value(ctx.source, 'COHERE_BASE_URL'),
    model: COHERE_PROBE_MODEL,
  });
  await reranker.rerank(PROBE_TEXT, RERANK_DOCUMENTS, { signal: ctx.signal, timeoutMs: PROVIDER_PROBE_TIMEOUT_MS });
}

async function probeVoyageRerank(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'VOYAGE_API_KEY');
  let reranker;
  try {
    reranker = createVoyageReranker({
      fetch: ctx.fetch,
      apiKey: value(ctx.source, 'VOYAGE_API_KEY'),
      baseUrl: value(ctx.source, 'VOYAGE_BASE_URL'),
      model: VOYAGE_PROBE_MODEL,
    });
  } catch {
    fail('invalid_config');
  }
  await reranker.rerank(PROBE_TEXT, RERANK_DOCUMENTS, { signal: ctx.signal, timeoutMs: PROVIDER_PROBE_TIMEOUT_MS });
}

async function probeQdrant(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'QDRANT_URL');
  let client: QdrantApi;
  try {
    client = ctx.deps.qdrantReadClient(ctx.source);
  } catch {
    fail('invalid_config');
  }
  const health = await qdrantHealth(client);
  if (!health.ok) {
    const status = /^http_(\d{3})$/.exec(health.detail ?? '');
    fail(status ? codeForStatus(Number(status[1])) : ctx.signal.aborted ? 'timeout' : 'unreachable');
  }
  const profileId = await ctx.deps.activeProfileId();
  let info;
  try {
    info = await describeQdrantCollection(client, profileId);
  } catch (error) {
    const status = qdrantErrorStatus(error) ?? Number(/\((\d{3})\)/.exec(error instanceof Error ? error.message : '')?.[1] ?? NaN);
    fail(Number.isInteger(status) ? codeForStatus(status) : ctx.signal.aborted ? 'timeout' : 'unreachable');
  }
  if (info === null) fail('collection_missing');
}

async function probeWeaviate(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'WEAVIATE_URL');
  try {
    resolveWeaviateConnection('read', {
      WEAVIATE_URL: ctx.source.WEAVIATE_URL,
      WEAVIATE_API_KEY: ctx.source.WEAVIATE_API_KEY,
      WEAVIATE_READ_API_KEY: ctx.source.WEAVIATE_READ_API_KEY,
      NODE_ENV: ctx.source.NODE_ENV ?? process.env.NODE_ENV,
    });
  } catch {
    fail('invalid_config');
  }
  let client: WeaviateClientLike;
  try {
    client = await ctx.deps.weaviateReadClient();
  } catch {
    fail(ctx.signal.aborted ? 'timeout' : 'unreachable');
  }
  let ready = false;
  try {
    ready = await client.isReady();
  } catch (error) {
    if (ctx.signal.aborted) fail('timeout');
    const mapped = mapWeaviateError(error, 'health');
    fail(mapped instanceof RetrievalBackendError && mapped.code === 'permission_denied' ? 'unauthorized' : 'unreachable');
  }
  if (!ready) fail('unreachable');
  const state = await describeWeaviateCollection(client, await ctx.deps.activeProfileId());
  if (!state.exists) fail('collection_missing');
}

async function probeSidecar(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'RAG_SIDECAR_URL', 'RAG_SIDECAR_SECRET');
  const base = value(ctx.source, 'RAG_SIDECAR_URL').replace(/\/+$/, '');
  const headers = { [SIDECAR_SECRET_HEADER]: value(ctx.source, 'RAG_SIDECAR_SECRET'), accept: 'application/json' };
  await drain(await request(ctx, `${base}/ready`, { method: 'GET', headers }));
  // /ready is open to probes; /v1/info sits behind the shared secret, so a wrong secret shows here.
  await drain(await request(ctx, `${base}/v1/info`, { method: 'GET', headers }));
}

async function probeVectara(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'RAG_SIDECAR_URL', 'RAG_SIDECAR_SECRET');
  const base = value(ctx.source, 'RAG_SIDECAR_URL').replace(/\/+$/, '');
  const response = await request(ctx, `${base}${SIDECAR_PROVIDER_TEST_PATH}`, {
    method: 'POST',
    headers: { [SIDECAR_SECRET_HEADER]: value(ctx.source, 'RAG_SIDECAR_SECRET'), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ provider: 'vectara' }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fail(ctx.signal.aborted ? 'timeout' : 'bad_response');
  }
  const parsed = ProviderTestResultSchema.safeParse(body);
  if (!parsed.success || parsed.data.ok !== (parsed.data.code === 'ok')) fail('bad_response');
  const code: ProviderProbeCode = parsed.data.code;
  if (code !== 'ok') fail(code);
}

async function probeLangfuse(ctx: ProbeContext): Promise<void> {
  const config = readLangfuseConfig(ctx.source);
  if (config.publicKey.trim() === '' || config.secretKey.trim() === '') fail('not_configured');
  const basic = Buffer.from(`${config.publicKey.trim()}:${config.secretKey.trim()}`).toString('base64');
  await drain(await request(ctx, `${config.baseUrl}/api/public/projects`, { method: 'GET', headers: { authorization: `Basic ${basic}`, accept: 'application/json' } }));
}

async function probeLakera(ctx: ProbeContext): Promise<void> {
  const security = readSecurityConfig(ctx.source);
  if (!security.lakeraApiKey) fail('not_configured');
  // The probe screens only the fixed text "ok", so it sends no tenant data and needs neither the switches nor the multi-tenant ack.
  const base = loadInjectionDetectorConfig().lakera;
  const detector = createLakeraDetector({
    config: { ...base, profiles: ['chat'], concurrency: 1 },
    fetch: ctx.fetch,
    gate: () => ({
      injectionCheck: 'flag',
      lakera: true,
      multiTenant: false,
      ack: true,
      apiKey: security.lakeraApiKey,
      baseUrl: security.lakeraBaseUrl,
    }),
    timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
  });
  // The Lakera detector reads no tenant scope; the probe has none to give.
  const [outcome] = await detector.classify([PROBE_TEXT], { signal: ctx.signal, profile: 'chat', traceId: null, scope: null as unknown as TenantScope });
  if (!outcome) fail('bad_response');
  if (outcome.kind === 'verdict') return;
  switch (outcome.reason) {
    case 'no_breakdown':
    case 'detector_missing':
      return;
    case 'http_401':
      fail('unauthorized');
    case 'http_429':
      fail('rate_limited');
    case 'timeout':
    case 'aborted':
      fail('timeout');
    case 'network':
      fail('unreachable');
    case 'malformed':
      fail('bad_response');
    default:
      fail('provider_error');
  }
}

async function probeLlamaCloud(ctx: ProbeContext): Promise<void> {
  if (value(ctx.source, 'RAG_PARSER_ALLOW_CLOUD') === 'false') fail('disabled');
  requireValues(ctx.source, 'LLAMA_CLOUD_API_KEY');
  await drain(
    await request(ctx, `${LLAMA_CLOUD_API_BASE}/api/v1/projects`, {
      method: 'GET',
      headers: { authorization: `Bearer ${value(ctx.source, 'LLAMA_CLOUD_API_KEY')}`, accept: 'application/json' },
    }),
  );
}

async function probeAnthropic(ctx: ProbeContext): Promise<void> {
  const config = readGenerationConfig(ctx.source);
  if (!config.anthropicApiKey) fail('not_configured');
  await drain(
    await request(ctx, `${config.anthropicBaseUrl}/models?limit=1`, {
      method: 'GET',
      headers: { 'x-api-key': config.anthropicApiKey, 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' },
    }),
  );
}

async function probeExa(ctx: ProbeContext): Promise<void> {
  requireValues(ctx.source, 'EXA_API_KEY');
  await drain(
    await request(ctx, EXA_SEARCH_URL, {
      method: 'POST',
      headers: { 'x-api-key': value(ctx.source, 'EXA_API_KEY'), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: PROBE_TEXT, numResults: 1 }),
    }),
  );
}

const PROBES: Readonly<Record<ProviderId, (ctx: ProbeContext) => Promise<void>>> = {
  'embedding:openai': probeOpenAiEmbedding,
  'embedding:voyage': probeVoyageEmbedding,
  'embedding:deepinfra': probeDeepInfraEmbedding,
  'rerank:cohere': probeCohereRerank,
  'rerank:voyage': probeVoyageRerank,
  'backend:weaviate': probeWeaviate,
  'backend:qdrant': probeQdrant,
  sidecar: probeSidecar,
  langfuse: probeLangfuse,
  vectara: probeVectara,
  lakera: probeLakera,
  llamacloud: probeLlamaCloud,
  anthropic: probeAnthropic,
  exa: probeExa,
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

function defaultDeps(): ProviderProbeDeps {
  return {
    env: loadedEnv as unknown as ProbeEnv,
    fetch: (input, init) => getRagDeps().fetch(input, init),
    now: () => performance.now(),
    activeProfileId: async () => (await getActiveProfile()).id,
    qdrantReadClient: (source) =>
      buildQdrantClients({
        url: source.QDRANT_URL ?? '',
        apiKey: source.QDRANT_API_KEY ?? '',
        readApiKey: source.QDRANT_READ_API_KEY ?? '',
        nodeEnv: process.env.NODE_ENV,
      }).read,
    weaviateReadClient: () => getWeaviateReadClient(),
  };
}

function result(provider: ProviderId, code: ProviderProbeCode, latencyMs: number): ProviderProbeResult {
  return { provider, ok: code === 'ok', latencyMs, code, message: PROVIDER_PROBE_MESSAGES[code] };
}

/**
 * Runs one probe within the caller's signal (the route passes a 10 s timeout). An adapter that ignores the signal still ends the
 * probe when it fires. A provider without its key or URL returns not_configured before any network call.
 */
export async function runProviderProbe(provider: ProviderId, options: RunProviderProbeOptions): Promise<ProviderProbeResult> {
  if (!isProviderId(provider)) throw new TypeError('[RAG Admin] unknown provider probe');
  const deps: ProviderProbeDeps = { ...defaultDeps(), ...options.deps };
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const ctx: ProbeContext = { source: deps.env, signal, deps, fetch: guardedFetch(deps, signal) };
  const started = deps.now();
  const elapsed = (): number => Math.max(0, Math.round(deps.now() - started));

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProbeFailure('timeout'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);

  try {
    await Promise.race([PROBES[provider](ctx), aborted]);
    return result(provider, 'ok', elapsed());
  } catch (error) {
    const code = codeForError(error, signal);
    return result(provider, code, code === 'not_configured' || code === 'disabled' || code === 'invalid_config' ? 0 : elapsed());
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}
