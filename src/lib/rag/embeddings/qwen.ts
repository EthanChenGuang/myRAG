import OpenAI from 'openai';
import { env } from '@/lib/env';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { EmbeddingProfileMismatch, truncateAndNormalize } from './mrl';
import type { EmbedOptions, EmbedOutput, EmbeddingProvider } from './types';
import {
  EmbeddingProviderError,
  QWEN_MODEL_ID,
  QWEN_NATIVE_DIMS,
  QWEN_SUPPORTED_DIMS,
  canonicalModelId,
  isAbortError,
  toProviderError,
} from './types';

export const QWEN_QUERY_TASK = 'Given a web search query, retrieve relevant passages that answer the query';

const DEEPINFRA = 'deepinfra';
const OPENROUTER = 'openrouter';
const OPENROUTER_MODEL_ID = 'qwen/qwen3-embedding-8b';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_TEXTS_PER_REQUEST = 128;
const MAX_INPUT_TOKENS = 32_768;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface QwenHostConfig {
  apiKey: string;
  baseUrl: string;
}

export interface QwenConfig {
  deepinfra: QwenHostConfig;
  openrouter: QwenHostConfig;
  /** Host tried first; `undefined` means DeepInfra. The other host is the fallback. */
  primary?: 'deepinfra' | 'openrouter';
  /** `none` disables the fallback to the non-primary host. */
  fallback: 'openrouter' | 'none';
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface QwenProviderOptions {
  config?: () => QwenConfig;
}

function defaultConfig(): QwenConfig {
  const ingest = loadIngestConfig({
    RAG_QWEN_EMBED_FALLBACK: env.RAG_QWEN_EMBED_FALLBACK,
    RAG_QWEN_EMBED_PRIMARY: env.RAG_QWEN_EMBED_PRIMARY,
  });
  return {
    deepinfra: { apiKey: env.DEEPINFRA_API_KEY, baseUrl: env.DEEPINFRA_BASE_URL },
    openrouter: { apiKey: env.OPENROUTER_API_KEY || '', baseUrl: OPENROUTER_BASE_URL },
    primary: ingest.qwenPrimary,
    fallback: ingest.qwenFallback,
  };
}

interface QwenHost {
  name: string;
  keyName: string;
  model: string;
  config: QwenHostConfig;
}

/** Orders the two hosts by the configured primary; both serve the same model under different ids. */
function hostsFor(config: QwenConfig): { primary: QwenHost; secondary: QwenHost } {
  const deepinfra: QwenHost = { name: DEEPINFRA, keyName: 'DEEPINFRA_API_KEY', model: QWEN_MODEL_ID, config: config.deepinfra };
  const openrouter: QwenHost = {
    name: OPENROUTER,
    keyName: 'OPENROUTER_API_KEY',
    model: OPENROUTER_MODEL_ID,
    config: config.openrouter,
  };
  return config.primary === OPENROUTER
    ? { primary: openrouter, secondary: deepinfra }
    : { primary: deepinfra, secondary: openrouter };
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

/** Documented fallback triggers: 5xx, 429 and timeouts or dropped connections (no HTTP status). */
function isFallbackTrigger(error: unknown): error is EmbeddingProviderError {
  if (!(error instanceof EmbeddingProviderError)) return false;
  return error.status === undefined || error.status >= 500 || error.status === 429;
}

interface HostResult {
  rows: { embedding: number[]; index: number }[];
  model: string;
  tokens: number | undefined;
}

async function requestHost(
  host: string,
  hostConfig: QwenHostConfig,
  model: string,
  inputs: string[],
  opts: EmbedOptions,
  config: QwenConfig,
): Promise<HostResult> {
  const client = new OpenAI({
    apiKey: hostConfig.apiKey,
    baseURL: hostConfig.baseUrl,
    maxRetries: 0,
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  try {
    const response = await client.embeddings.create(
      { model, input: inputs, encoding_format: 'float' },
      { signal: opts.signal },
    );
    return {
      rows: response.data.map((item) => ({ embedding: item.embedding, index: item.index })),
      model: response.model || model,
      tokens: response.usage?.total_tokens,
    };
  } catch (error) {
    throw toProviderError(error, host, opts.signal);
  }
}

export function createQwenProvider(options: QwenProviderOptions = {}): EmbeddingProvider {
  const getConfig = options.config ?? defaultConfig;

  async function primaryWithRetries(
    primary: QwenHost,
    inputs: string[],
    opts: EmbedOptions,
    config: QwenConfig,
  ): Promise<HostResult> {
    const retries = config.retries ?? DEFAULT_RETRIES;
    const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await requestHost(primary.name, primary.config, primary.model, inputs, opts, config);
      } catch (error) {
        if (isAbortError(error, opts.signal) || !isFallbackTrigger(error)) throw error;
        last = error;
        if (attempt < retries) await sleep(backoffMs * (attempt + 1), opts.signal);
      }
    }
    throw last;
  }

  async function embed(texts: string[], opts: EmbedOptions): Promise<EmbedOutput> {
    const config = getConfig();
    const { primary, secondary } = hostsFor(config);
    if (!primary.config.apiKey) throw new Error(`[Embedding Profile] ${primary.keyName} not configured`);

    const vectors: number[][] = [];
    const models = new Set<string>();
    let tokens = 0;
    let usedFallback = false;
    let primaryDown = false;

    for (let start = 0; start < texts.length; start += MAX_TEXTS_PER_REQUEST) {
      const inputs = texts.slice(start, start + MAX_TEXTS_PER_REQUEST);
      let result: HostResult | undefined;
      if (!primaryDown) {
        try {
          result = await primaryWithRetries(primary, inputs, opts, config);
        } catch (error) {
          const canFallBack = config.fallback !== 'none' && Boolean(secondary.config.apiKey);
          if (isAbortError(error, opts.signal) || !isFallbackTrigger(error) || !canFallBack) throw error;
          primaryDown = true;
          console.warn('[Embedding Profile] primary host failed, falling back', {
            from: primary.name,
            to: secondary.name,
            status: error.status ?? 'no response',
          });
        }
      }
      if (!result) {
        usedFallback = true;
        result = await requestHost(secondary.name, secondary.config, secondary.model, inputs, opts, config);
      }

      if (result.rows.length !== inputs.length) throw new Error('[Embedding Profile] qwen3 returned a malformed response');
      const ordered = [...result.rows].sort((a, b) => a.index - b.index);
      for (const row of ordered) {
        if (row.embedding.length !== QWEN_NATIVE_DIMS) {
          throw new EmbeddingProfileMismatch('dims', row.embedding.length, QWEN_NATIVE_DIMS);
        }
        vectors.push(truncateAndNormalize(row.embedding, opts.dims));
      }
      models.add(canonicalModelId(result.model));
      tokens += result.tokens ?? inputs.reduce((sum, text) => sum + countTokens(text), 0);
    }

    const model = [...models].find((id) => id !== QWEN_MODEL_ID) ?? QWEN_MODEL_ID;
    return { vectors, model, host: usedFallback ? secondary.name : primary.name, usage: { tokens } };
  }

  return {
    id: 'qwen3',
    model: QWEN_MODEL_ID,
    maxInputTokens: MAX_INPUT_TOKENS,
    supportedDims: QWEN_SUPPORTED_DIMS,
    normalize: true,
    embedDocuments: (texts, opts) => embed(texts, opts),
    embedQuery: (text, opts) => embed([`Instruct: ${QWEN_QUERY_TASK}\nQuery:${text}`], opts),
    embedQueries: (texts, opts) => embed(texts.map((text) => `Instruct: ${QWEN_QUERY_TASK}\nQuery:${text}`), opts),
  };
}
