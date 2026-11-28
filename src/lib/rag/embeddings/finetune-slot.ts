import OpenAI from 'openai';
import { env } from '@/lib/env';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { countTokens } from '../ingest/text/tokens';
import { EmbeddingProfileMismatch, truncateAndNormalize } from './mrl';
import type { EmbedOptions, EmbedOutput, EmbeddingProvider, FinetuneSlotProviderId } from './types';
import { EmbeddingProviderError, FT_SLOT_DIMS, FT_SLOT_SUPPORTED_DIMS, isAbortError, toProviderError } from './types';

export type FinetuneSlot = 'a' | 'b';

const MAX_TEXTS_PER_REQUEST = 128;
const MAX_INPUT_TOKENS = 8192;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;
const LIST_MODELS_RPC = 'rag_finetune_list_models';

/** Cosine every probe vector must reach against its stored reference (06.1 D-24). */
export const FINETUNE_PROBE_MIN_COSINE = 0.999;

/**
 * The prompt each of the three probe texts is embedded with, here and when training computes the reference vectors: the first and
 * third as queries, the second as a document, so a drift of either serving prompt fails the probe.
 */
export const FINETUNE_PROBE_ROLES: readonly ('query' | 'document')[] = Object.freeze(['query', 'document', 'query'] as const);

export interface FinetuneSlotConfig {
  baseUrl: string;
  /** The registered model version id; the EMB-03 checks compare it with the slot profile's model. */
  model: string;
  queryPrompt: string;
  documentPrompt: string;
  /** May be empty on a private network; then no Authorization header is sent. */
  apiKey: string;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface FinetuneSlotProviderOptions {
  config?: () => FinetuneSlotConfig;
}

export type FinetuneProbeReason = 'match' | 'mismatch' | 'unregistered' | 'not_bound' | 'malformed' | 'unconfigured' | 'unavailable' | 'disabled';

export interface FinetuneProbeResult {
  ok: boolean;
  /** Lowest cosine of the three probes; null when the probe could not be embedded. */
  minCosine: number | null;
  reason: FinetuneProbeReason;
}

interface ProbeRecord {
  texts: string[];
  vectors: number[][];
}

/** A probe that ran to a verdict. Errors that kept it from running are not verdicts and are never cached. */
type ProbeVerdict =
  | { ok: true; minCosine: number }
  | { ok: false; minCosine: number | null; reason: 'mismatch' | 'unregistered' | 'not_bound' | 'malformed'; error: EmbeddingProfileMismatch };

const probeCache = new Map<string, Promise<ProbeVerdict>>();

function providerId(slot: FinetuneSlot): FinetuneSlotProviderId {
  return slot === 'a' ? 'ft_slot_a' : 'ft_slot_b';
}

function slotProfileId(slot: FinetuneSlot): string {
  return `ft-${slot}-${FT_SLOT_DIMS}`;
}

function envName(slot: FinetuneSlot, field: 'BASE_URL' | 'MODEL'): string {
  return `RAG_FT_SLOT_${slot.toUpperCase()}_${field}`;
}

function envConfig(slot: FinetuneSlot): FinetuneSlotConfig {
  const a = slot === 'a';
  return {
    baseUrl: (a ? env.RAG_FT_SLOT_A_BASE_URL : env.RAG_FT_SLOT_B_BASE_URL).trim(),
    model: (a ? env.RAG_FT_SLOT_A_MODEL : env.RAG_FT_SLOT_B_MODEL).trim(),
    queryPrompt: a ? env.RAG_FT_SLOT_A_QUERY_PROMPT : env.RAG_FT_SLOT_B_QUERY_PROMPT,
    documentPrompt: a ? env.RAG_FT_SLOT_A_DOCUMENT_PROMPT : env.RAG_FT_SLOT_B_DOCUMENT_PROMPT,
    apiKey: env.RAG_FT_EMBED_API_KEY.trim(),
  };
}

class SlotUnconfiguredError extends Error {
  constructor(variable: string) {
    super(`[Embedding Profile] ${variable} not configured`);
    this.name = 'SlotUnconfiguredError';
  }
}

function assertConfigured(slot: FinetuneSlot, config: FinetuneSlotConfig): void {
  if (!config.baseUrl.trim()) throw new SlotUnconfiguredError(envName(slot, 'BASE_URL'));
  if (!config.model.trim()) throw new SlotUnconfiguredError(envName(slot, 'MODEL'));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 5xx, 429 and timeouts or dropped connections (no HTTP status) are retried, as in the Qwen provider. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof EmbeddingProviderError)) return false;
  return error.status === undefined || error.status >= 500 || error.status === 429;
}

interface BatchResult {
  vectors: number[][];
  tokens: number;
}

async function requestOnce(host: string, config: FinetuneSlotConfig, inputs: string[], signal: AbortSignal): Promise<BatchResult> {
  const key = config.apiKey.trim();
  // Explicit apiKey, organization and project keep the SDK from reading OPENAI_* variables and sending them to the slot endpoint.
  const client = new OpenAI({
    apiKey: key || 'not-used',
    baseURL: config.baseUrl.trim(),
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    defaultHeaders: key ? undefined : { Authorization: null },
  });
  let response;
  try {
    response = await client.embeddings.create({ model: config.model.trim(), input: inputs, encoding_format: 'float' }, { signal });
  } catch (error) {
    throw toProviderError(error, host, signal);
  }
  const rows = Array.isArray(response?.data) ? response.data : [];
  if (rows.length !== inputs.length) throw new Error(`[Embedding Profile] ${host} returned a malformed response`);
  const ordered = [...rows].sort((a, b) => a.index - b.index);
  const vectors = ordered.map((row) => {
    const embedding = row.embedding as unknown;
    if (!Array.isArray(embedding)) throw new Error(`[Embedding Profile] ${host} returned a malformed response`);
    if (embedding.length !== FT_SLOT_DIMS) throw new EmbeddingProfileMismatch('dims', embedding.length, FT_SLOT_DIMS);
    return truncateAndNormalize(embedding as number[], FT_SLOT_DIMS);
  });
  const tokens = response.usage?.total_tokens ?? inputs.reduce((sum, text) => sum + countTokens(text), 0);
  return { vectors, tokens };
}

async function requestWithRetries(host: string, config: FinetuneSlotConfig, inputs: string[], signal: AbortSignal): Promise<BatchResult> {
  const retries = config.retries ?? DEFAULT_RETRIES;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestOnce(host, config, inputs, signal);
    } catch (error) {
      if (isAbortError(error, signal) || !isRetryable(error)) throw error;
      last = error;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1), signal);
    }
  }
  throw last;
}

/** Embeds texts exactly as given (prompts already applied), in batches of at most 128, keeping the order. */
async function embedRaw(host: string, config: FinetuneSlotConfig, inputs: string[], signal: AbortSignal): Promise<BatchResult> {
  const vectors: number[][] = [];
  let tokens = 0;
  for (let start = 0; start < inputs.length; start += MAX_TEXTS_PER_REQUEST) {
    const batch = await requestWithRetries(host, config, inputs.slice(start, start + MAX_TEXTS_PER_REQUEST), signal);
    vectors.push(...batch.vectors);
    tokens += batch.tokens;
  }
  return { vectors, tokens };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseProbe(value: unknown): ProbeRecord | null {
  const probe = asRecord(value);
  if (!probe) return null;
  const { texts, vectors } = probe;
  if (!Array.isArray(texts) || texts.length !== FINETUNE_PROBE_ROLES.length || !texts.every((text) => typeof text === 'string' && text !== '')) {
    return null;
  }
  if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
  const parsed: number[][] = [];
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== FT_SLOT_DIMS) return null;
    if (!vector.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    try {
      parsed.push(truncateAndNormalize(vector as number[], FT_SLOT_DIMS));
    } catch {
      return null;
    }
  }
  return { texts: texts as string[], vectors: parsed };
}

/** Reads the version's probe on the service-role client (rag_finetune_list_models is service_role only). Server only. */
async function loadProbe(slot: FinetuneSlot, versionId: string): Promise<ProbeRecord | ProbeVerdict> {
  const { getRagDeps } = await import('../deps');
  const admin = getRagDeps().adminClient() as unknown as RpcClient | null;
  if (!admin) throw new Error('[Embedding Profile] fine-tune probe needs the service-role client');
  let response;
  try {
    response = await admin.rpc(LIST_MODELS_RPC, { p_include_probe: true });
  } catch {
    throw new Error('[Embedding Profile] fine-tune registry read failed');
  }
  if (response.error) throw new Error(`[Embedding Profile] fine-tune registry read failed${response.error.code ? ` (${response.error.code})` : ''}`);
  const row = rpcRows(response.data)
    .map(asRecord)
    .find((candidate) => candidate?.id === versionId);
  if (!row) {
    return { ok: false, minCosine: null, reason: 'unregistered', error: new EmbeddingProfileMismatch('probe', 'unregistered', versionId) };
  }
  const expected = slotProfileId(slot);
  if (row.bound_slot !== expected) {
    const actual = typeof row.bound_slot === 'string' && row.bound_slot !== '' ? row.bound_slot : 'unbound';
    return { ok: false, minCosine: null, reason: 'not_bound', error: new EmbeddingProfileMismatch('probe', actual, expected) };
  }
  const probe = parseProbe(row.probe);
  if (!probe) return { ok: false, minCosine: null, reason: 'malformed', error: new EmbeddingProfileMismatch('probe', 'malformed', 'probe') };
  return probe;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

async function runProbe(slot: FinetuneSlot, config: FinetuneSlotConfig): Promise<ProbeVerdict> {
  const loaded = await loadProbe(slot, config.model.trim());
  if ('ok' in loaded) return loaded;
  const inputs = loaded.texts.map((text, index) => `${FINETUNE_PROBE_ROLES[index] === 'query' ? config.queryPrompt : config.documentPrompt}${text}`);
  const { vectors } = await embedRaw(providerId(slot), config, inputs, new AbortController().signal);
  const minCosine = Math.min(...vectors.map((vector, index) => dot(vector, loaded.vectors[index])));
  if (minCosine >= FINETUNE_PROBE_MIN_COSINE) return { ok: true, minCosine };
  console.error(`[Embedding Profile] PROBE MISMATCH ${JSON.stringify({ profile: slotProfileId(slot), model: config.model.trim(), minCosine })}`);
  return {
    ok: false,
    minCosine,
    reason: 'mismatch',
    error: new EmbeddingProfileMismatch('probe', minCosine, FINETUNE_PROBE_MIN_COSINE),
  };
}

/** Everything that decides the probe's outcome; a change of any of them probes again. */
function probeKey(slot: FinetuneSlot, config: FinetuneSlotConfig): string {
  return JSON.stringify([slot, config.baseUrl.trim(), config.model.trim(), config.queryPrompt, config.documentPrompt, config.apiKey !== '']);
}

/** One probe per process and configuration; concurrent callers share it. A probe that could not run is dropped and retried. */
function probeVerdict(slot: FinetuneSlot, config: FinetuneSlotConfig): Promise<ProbeVerdict> {
  const key = probeKey(slot, config);
  let pending = probeCache.get(key);
  if (!pending) {
    pending = runProbe(slot, config);
    probeCache.set(key, pending);
    pending.catch(() => {
      if (probeCache.get(key) === pending) probeCache.delete(key);
    });
  }
  return pending;
}

/**
 * Serves a fine-tuned model from an OpenAI-compatible `POST {base}/embeddings` endpoint (06.1 D-23). Before its first vector per
 * process it proves through the probe that the endpoint serves the registered weights with the registered prompts (D-24).
 */
export function createFinetuneSlotProvider(slot: FinetuneSlot, options: FinetuneSlotProviderOptions = {}): EmbeddingProvider {
  const getConfig = options.config ?? (() => envConfig(slot));
  const id = providerId(slot);

  async function embed(texts: string[], prompt: (config: FinetuneSlotConfig) => string, opts: EmbedOptions): Promise<EmbedOutput> {
    if (opts.dims !== FT_SLOT_DIMS) throw new EmbeddingProfileMismatch('dims', opts.dims, FT_SLOT_DIMS);
    const config = getConfig();
    assertConfigured(slot, config);
    const verdict = await probeVerdict(slot, config);
    if (!verdict.ok) throw verdict.error;
    const prefix = prompt(config);
    const { vectors, tokens } = await embedRaw(id, config, texts.map((text) => `${prefix}${text}`), opts.signal);
    return { vectors, model: config.model.trim(), host: id, usage: { tokens } };
  }

  return {
    id,
    get model() {
      return getConfig().model.trim();
    },
    maxInputTokens: MAX_INPUT_TOKENS,
    supportedDims: FT_SLOT_SUPPORTED_DIMS,
    normalize: true,
    embedDocuments: (texts, opts) => embed(texts, (config) => config.documentPrompt, opts),
    embedQuery: (text, opts) => embed([text], (config) => config.queryPrompt, opts),
    embedQueries: (texts, opts) => embed(texts, (config) => config.queryPrompt, opts),
  };
}

/** The probe check for `ft-check` (06.1-15): the same cached verdict the provider uses, returned instead of thrown. */
export async function checkFinetuneProbe(slot: FinetuneSlot, options: FinetuneSlotProviderOptions = {}): Promise<FinetuneProbeResult> {
  if (!options.config && env.RAG_FINETUNE !== 'on') return { ok: false, minCosine: null, reason: 'disabled' };
  const config = (options.config ?? (() => envConfig(slot)))();
  try {
    assertConfigured(slot, config);
  } catch {
    return { ok: false, minCosine: null, reason: 'unconfigured' };
  }
  try {
    const verdict = await probeVerdict(slot, config);
    return verdict.ok ? { ok: true, minCosine: verdict.minCosine, reason: 'match' } : { ok: false, minCosine: verdict.minCosine, reason: verdict.reason };
  } catch {
    return { ok: false, minCosine: null, reason: 'unavailable' };
  }
}

export function resetFinetuneProbeCacheForTests(): void {
  probeCache.clear();
}
