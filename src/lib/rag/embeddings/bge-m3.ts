import OpenAI from 'openai';
import { env } from '@/lib/env';
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

export interface BgeM3ProviderOptions {
  config?: () => BgeM3Config;
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

/** Hosted BGE-M3 (D-26) on DeepInfra's OpenAI-compatible endpoint: dense output only, no instruction, no output dimension. */
export function createBgeM3Provider(options: BgeM3ProviderOptions = {}): EmbeddingProvider {
  const getConfig = options.config ?? defaultConfig;

  async function embed(texts: string[], opts: EmbedOptions): Promise<EmbedOutput> {
    if (opts.dims !== BGE_M3_NATIVE_DIMS) throw new EmbeddingProfileMismatch('dims', opts.dims, BGE_M3_NATIVE_DIMS);
    checkInputs(texts);
    const config = getConfig();
    if (!config.apiKey) throw new Error('[Embedding Profile] DEEPINFRA_API_KEY not configured');
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: 0,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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
