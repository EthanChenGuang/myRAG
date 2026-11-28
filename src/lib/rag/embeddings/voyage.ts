import { env } from '@/lib/env';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { EmbeddingProfileMismatch } from './mrl';
import type { EmbedOptions, EmbedOutput, EmbeddingProvider } from './types';
import { catalogEntry } from './catalog';
import { EmbeddingProviderError, VOYAGE_MODEL_ID, canonicalModelId, toProviderError } from './types';

const HOST = 'voyage';
const MAX_TEXTS_PER_REQUEST = 128;
const MAX_ESTIMATED_TOKENS_PER_REQUEST = 100_000;
const TOKENIZER_SAFETY_FACTOR = 1.3;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface VoyageConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface VoyageProviderOptions {
  config?: () => VoyageConfig;
  /** A Voyage model from the embedding catalog; defaults to voyage-4-large. */
  model?: string;
}

function defaultConfig(): VoyageConfig {
  return { apiKey: env.VOYAGE_API_KEY, baseUrl: env.VOYAGE_BASE_URL };
}

function estimateTokens(text: string): number {
  return Math.ceil(countTokens(text) * TOKENIZER_SAFETY_FACTOR);
}

/**
 * Greedy batches of at most 128 texts and an estimated 100K tokens. The estimate is the cl100k_base
 * count times 1.3 because Voyage tokenizes differently; a single oversized text still goes out alone.
 */
export function splitIntoBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const text of texts) {
    const tokens = estimateTokens(text);
    if (current.length > 0 && (current.length >= MAX_TEXTS_PER_REQUEST || currentTokens + tokens > MAX_ESTIMATED_TOKENS_PER_REQUEST)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface VoyageResponse {
  data?: { embedding?: number[]; index?: number }[];
  model?: string;
  usage?: { total_tokens?: number };
}

export function createVoyageProvider(options: VoyageProviderOptions = {}): EmbeddingProvider {
  const getConfig = options.config ?? defaultConfig;
  const found = catalogEntry('voyage', options.model ?? VOYAGE_MODEL_ID);
  if (!found) throw new Error('[Embedding Profile] unknown embedding model for provider voyage');
  const entry = found;
  const modelId = entry.model;
  const supportedDims = entry.supportedDims;

  async function embedBatch(
    batch: string[],
    inputType: 'document' | 'query',
    opts: EmbedOptions,
    config: VoyageConfig,
  ): Promise<{ vectors: number[][]; model: string; tokens: number }> {
    let payload: VoyageResponse;
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: modelId,
          input: batch,
          input_type: inputType,
          ...(entry.sendsOutputDimension ? { output_dimension: opts.dims } : {}),
          truncation: false,
        }),
        signal: AbortSignal.any([opts.signal, AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new EmbeddingProviderError(HOST, response.status);
      }
      payload = (await response.json()) as VoyageResponse;
    } catch (error) {
      throw toProviderError(error, HOST, opts.signal);
    }

    const rows = payload.data;
    if (!Array.isArray(rows) || rows.length !== batch.length) {
      throw new Error('[Embedding Profile] voyage returned a malformed response');
    }
    const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((row) => {
      const embedding = row.embedding;
      if (!Array.isArray(embedding)) throw new Error('[Embedding Profile] voyage returned a malformed response');
      if (embedding.length !== opts.dims) throw new EmbeddingProfileMismatch('dims', embedding.length, opts.dims);
      return embedding;
    });
    const tokens = payload.usage?.total_tokens ?? batch.reduce((sum, text) => sum + estimateTokens(text), 0);
    return { vectors, model: canonicalModelId(payload.model || modelId), tokens };
  }

  async function embed(texts: string[], inputType: 'document' | 'query', opts: EmbedOptions): Promise<EmbedOutput> {
    const config = getConfig();
    if (!config.apiKey) throw new Error('[Embedding Profile] VOYAGE_API_KEY not configured');
    if (!entry.sendsOutputDimension && !supportedDims.includes(opts.dims)) {
      throw new EmbeddingProfileMismatch('dims', opts.dims, entry.nativeDims);
    }
    const vectors: number[][] = [];
    let model: string = modelId;
    let tokens = 0;
    for (const batch of splitIntoBatches(texts)) {
      const result = await embedBatch(batch, inputType, opts, config);
      vectors.push(...result.vectors);
      model = result.model;
      tokens += result.tokens;
    }
    return { vectors, model, host: HOST, usage: { tokens } };
  }

  return {
    id: 'voyage',
    model: modelId,
    maxInputTokens: entry.maxInputTokens,
    supportedDims,
    normalize: true,
    embedDocuments: (texts, opts) => embed(texts, 'document', opts),
    embedQuery: (text, opts) => embed([text], 'query', opts),
    embedQueries: (texts, opts) => embed(texts, 'query', opts),
  };
}
