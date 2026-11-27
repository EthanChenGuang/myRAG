import OpenAI from 'openai';
import { env } from '@/lib/env';
import type { BgeM3Serving } from '../config';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { EmbeddingProfileMismatch, truncateAndNormalize } from './mrl';
import type { EmbedOptions, EmbedOutput, EmbeddingProvider } from './types';
import { BGE_M3_MODEL_ID, BGE_M3_NATIVE_DIMS, EmbeddingInputError, canonicalModelId, statusOf, toProviderError } from './types';

const HOST = 'deepinfra';
const MAX_TEXTS_PER_REQUEST = 128;
const MODEL_INPUT_TOKEN_LIMIT = 8192;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The app counts cl100k_base tokens and the model counts its own (XLM-RoBERTa), which can be about twice as many for some
 * scripts, so the app refuses inputs above half the model limit in its own count instead of letting the host truncate.
 */
export const BGE_M3_APP_INPUT_TOKEN_LIMIT = MODEL_INPUT_TOKEN_LIMIT / 2;

const TOO_LONG_STATUSES: readonly number[] = [400, 413, 422];
const TOO_LONG_TEXT = /too long|maximum context|context length|max(imum)?[ _-]?(input|sequence)?[ _-]?(length|tokens)|exceeds?.*tokens/i;

export interface BgeM3Config {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

/** The BAAI/bge-m3 revision the sidecar image bakes; a sidecar answering with any other revision is refused (D-26). */
export const BGE_M3_SIDECAR_REVISION = '5617a9f61b028005a4858fdac845db406aefb181';

const SIDECAR_HOST = 'sidecar';
const SIDECAR_EMBED_PATH = '/v1/embed';
const SIDECAR_SECRET_HEADER = 'x-sidecar-secret';
const MAX_TEXTS_PER_SIDECAR_REQUEST = 32;
const MAX_SIDECAR_INPUT_CHARS = 20_000;
const DEFAULT_SIDECAR_TIMEOUT_MS = 60_000;

export type EmbeddingSidecarFailure =
  | 'not_configured'
  | 'timeout'
  | 'unreachable'
  | 'malformed'
  | 'revision_mismatch'
  | `http_${number}`;

/**
 * The sidecar could not embed. With RAG_BGE_M3_SERVING=sidecar this is the outcome of every sidecar failure: text of a
 * deployment that chose in-house serving is never sent to the hosted API instead (D-26).
 */
export class EmbeddingSidecarUnavailableError extends Error {
  readonly code = 'embedding_sidecar_unavailable';
  readonly host = SIDECAR_HOST;

  constructor(readonly reason: EmbeddingSidecarFailure) {
    super(`[Embedding Profile] embedding_sidecar_unavailable: ${reason}`);
    this.name = 'EmbeddingSidecarUnavailableError';
  }
}

export interface BgeM3SidecarConfig {
  url: string;
  secret: string;
  timeoutMs?: number;
}

export interface BgeM3ProviderOptions {
  config?: () => BgeM3Config;
  /** Defaults to the RAG config field bgeM3Serving (RAG_BGE_M3_SERVING), read on every call. */
  serving?: () => BgeM3Serving | Promise<BgeM3Serving>;
  /** Defaults to RAG_SIDECAR_URL and RAG_SIDECAR_SECRET. */
  sidecar?: () => BgeM3SidecarConfig;
  /** The sidecar request, and the hosted client's request when given. */
  fetch?: typeof fetch;
}

async function defaultServing(): Promise<BgeM3Serving> {
  const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../config'), import('../deps')]);
  return loadRagConfig(getRagDeps().ragEnv()).bgeM3Serving;
}

function defaultSidecarConfig(): BgeM3SidecarConfig {
  return { url: env.RAG_SIDECAR_URL ?? '', secret: env.RAG_SIDECAR_SECRET ?? '' };
}

function defaultConfig(): BgeM3Config {
  return { apiKey: env.DEEPINFRA_API_KEY, baseUrl: env.DEEPINFRA_BASE_URL };
}

function checkInputs(texts: string[]): void {
  if (texts.length === 0) throw new EmbeddingInputError('embedding_input_empty');
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) throw new EmbeddingInputError('embedding_input_empty');
  }
  for (const text of texts) {
    if (countTokens(text) > BGE_M3_APP_INPUT_TOKEN_LIMIT) throw new EmbeddingInputError('embedding_input_too_long');
  }
}

/** True when the host refused the request because an input is longer than the model accepts; the vendor text is not kept. */
function isHostTooLong(error: unknown): boolean {
  const status = statusOf(error);
  if (status === undefined || !TOO_LONG_STATUSES.includes(status)) return false;
  return TOO_LONG_TEXT.test(error instanceof Error ? error.message : '');
}

const SIDECAR_TOO_LONG = /^embed_input_too_long\b/;

async function sidecarBatch(
  inputs: string[],
  endpoint: string,
  secret: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIDECAR_SECRET_HEADER]: secret },
    body: JSON.stringify({ model: BGE_M3_MODEL_ID, inputs }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    let code = '';
    try {
      code = String(((await response.json()) as { error?: unknown } | null)?.error ?? '');
    } catch {
      code = '';
    }
    if (response.status === 422 && SIDECAR_TOO_LONG.test(code)) throw new EmbeddingInputError('embedding_input_too_long');
    throw new EmbeddingSidecarUnavailableError(`http_${response.status}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new EmbeddingSidecarUnavailableError('malformed');
  }
  const body = (raw ?? {}) as { model?: unknown; revision?: unknown; vectors?: unknown };
  const returned = canonicalModelId(typeof body.model === 'string' ? body.model : '');
  if (returned !== BGE_M3_MODEL_ID) throw new EmbeddingProfileMismatch('model', returned || 'none', BGE_M3_MODEL_ID);
  if (body.revision !== BGE_M3_SIDECAR_REVISION) {
    throw new EmbeddingSidecarUnavailableError(typeof body.revision === 'string' ? 'revision_mismatch' : 'malformed');
  }
  if (!Array.isArray(body.vectors) || body.vectors.length !== inputs.length) throw new EmbeddingSidecarUnavailableError('malformed');
  return body.vectors.map((vector: unknown) => {
    if (!Array.isArray(vector) || vector.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new EmbeddingSidecarUnavailableError('malformed');
    }
    if (vector.length !== BGE_M3_NATIVE_DIMS) throw new EmbeddingProfileMismatch('dims', vector.length, BGE_M3_NATIVE_DIMS);
    return truncateAndNormalize(vector as number[], BGE_M3_NATIVE_DIMS);
  });
}

/**
 * BGE-M3 served by the sidecar's POST /v1/embed (D-26). Every failure is an EmbeddingSidecarUnavailableError, an input
 * error or a profile mismatch; nothing here reaches the hosted API.
 */
async function embedWithSidecar(
  texts: string[],
  opts: EmbedOptions,
  config: BgeM3SidecarConfig,
  fetchImpl: typeof fetch,
): Promise<EmbedOutput> {
  for (const text of texts) {
    if (text.length > MAX_SIDECAR_INPUT_CHARS) throw new EmbeddingInputError('embedding_input_too_long');
  }
  const baseUrl = (config.url ?? '').trim().replace(/\/+$/, '');
  const secret = (config.secret ?? '').trim();
  if (!baseUrl || !secret) throw new EmbeddingSidecarUnavailableError('not_configured');
  const timeoutMs = config.timeoutMs !== undefined && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_SIDECAR_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([opts.signal, deadline]);
  const endpoint = `${baseUrl}${SIDECAR_EMBED_PATH}`;

  const vectors: number[][] = [];
  try {
    for (let start = 0; start < texts.length; start += MAX_TEXTS_PER_SIDECAR_REQUEST) {
      vectors.push(...(await sidecarBatch(texts.slice(start, start + MAX_TEXTS_PER_SIDECAR_REQUEST), endpoint, secret, signal, fetchImpl)));
    }
  } catch (error) {
    if (opts.signal.aborted) throw error;
    if (error instanceof EmbeddingSidecarUnavailableError || error instanceof EmbeddingInputError || error instanceof EmbeddingProfileMismatch) {
      throw error;
    }
    throw new EmbeddingSidecarUnavailableError(deadline.aborted ? 'timeout' : 'unreachable');
  }
  const tokens = texts.reduce((sum, text) => sum + countTokens(text), 0);
  return { vectors, model: BGE_M3_MODEL_ID, host: SIDECAR_HOST, usage: { tokens } };
}

/**
 * BGE-M3 (D-26) under one profile, served either by DeepInfra's OpenAI-compatible endpoint (hosted) or by the sidecar
 * (RAG_BGE_M3_SERVING=sidecar): dense output only, no instruction, no output dimension. Both modes give the same vectors
 * within the D-26 tolerance, so switching needs no re-embedding; sidecar mode never falls back to the hosted API.
 */
export function createBgeM3Provider(options: BgeM3ProviderOptions = {}): EmbeddingProvider {
  const getConfig = options.config ?? defaultConfig;
  const getServing = options.serving ?? defaultServing;
  const getSidecarConfig = options.sidecar ?? defaultSidecarConfig;

  async function embed(texts: string[], opts: EmbedOptions): Promise<EmbedOutput> {
    if (opts.dims !== BGE_M3_NATIVE_DIMS) throw new EmbeddingProfileMismatch('dims', opts.dims, BGE_M3_NATIVE_DIMS);
    checkInputs(texts);
    if ((await getServing()) === 'sidecar') return embedWithSidecar(texts, opts, getSidecarConfig(), options.fetch ?? fetch);
    const config = getConfig();
    if (!config.apiKey) throw new Error('[Embedding Profile] DEEPINFRA_API_KEY not configured');
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.fetch ? { fetch: options.fetch as never } : {}),
    });

    const vectors: number[][] = [];
    let tokens = 0;
    for (let start = 0; start < texts.length; start += MAX_TEXTS_PER_REQUEST) {
      const inputs = texts.slice(start, start + MAX_TEXTS_PER_REQUEST);
      let response;
      try {
        response = await client.embeddings.create(
          { model: BGE_M3_MODEL_ID, input: inputs, encoding_format: 'float' },
          { signal: opts.signal },
        );
      } catch (error) {
        if (!opts.signal.aborted && isHostTooLong(error)) throw new EmbeddingInputError('embedding_input_too_long');
        throw toProviderError(error, HOST, opts.signal);
      }

      const returned = canonicalModelId(response.model || '');
      if (returned !== BGE_M3_MODEL_ID) throw new EmbeddingProfileMismatch('model', returned || 'none', BGE_M3_MODEL_ID);
      const rows = Array.isArray(response.data) ? response.data : [];
      const byIndex = new Map<number, number[]>();
      for (const row of rows) {
        if (!Number.isInteger(row.index) || !Array.isArray(row.embedding) || byIndex.has(row.index)) {
          throw new Error('[Embedding Profile] bge-m3 returned a malformed response');
        }
        byIndex.set(row.index, row.embedding);
      }
      if (byIndex.size !== inputs.length) throw new Error('[Embedding Profile] bge-m3 returned a malformed response');
      for (let index = 0; index < inputs.length; index += 1) {
        const embedding = byIndex.get(index);
        if (!embedding) throw new Error('[Embedding Profile] bge-m3 returned a malformed response');
        if (embedding.length !== BGE_M3_NATIVE_DIMS) throw new EmbeddingProfileMismatch('dims', embedding.length, BGE_M3_NATIVE_DIMS);
        vectors.push(truncateAndNormalize(embedding, BGE_M3_NATIVE_DIMS));
      }
      tokens += response.usage?.total_tokens ?? inputs.reduce((sum, text) => sum + countTokens(text), 0);
    }
    return { vectors, model: BGE_M3_MODEL_ID, host: HOST, usage: { tokens } };
  }

  return {
    id: 'bge-m3',
    model: BGE_M3_MODEL_ID,
    maxInputTokens: BGE_M3_APP_INPUT_TOKEN_LIMIT,
    supportedDims: [BGE_M3_NATIVE_DIMS],
    normalize: true,
    embedDocuments: (texts, opts) => embed(texts, opts),
    embedQuery: (text, opts) => embed([text], opts),
    embedQueries: (texts, opts) => embed(texts, opts),
  };
}
