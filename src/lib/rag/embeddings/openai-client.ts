import { env } from '@/lib/env';

export type OpenAiEmbeddingsVia = 'openai' | 'openrouter';

export const OPENROUTER_EMBEDDINGS_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenAiEmbeddingsEnv {
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  RAG_OPENAI_EMBEDDINGS_VIA?: string;
}

export interface OpenAiEmbeddingsClientOptions {
  apiKey: string | undefined;
  baseURL?: string;
}

let warnedValue: string | null = null;

/** RAG_OPENAI_EMBEDDINGS_VIA: which host serves the OpenAI embedding model. Unknown values keep openai. */
export function openAiEmbeddingsVia(source: OpenAiEmbeddingsEnv = env): OpenAiEmbeddingsVia {
  const raw = (source.RAG_OPENAI_EMBEDDINGS_VIA ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'openai') return 'openai';
  if (raw === 'openrouter') return 'openrouter';
  if (warnedValue !== raw) {
    warnedValue = raw;
    console.warn(`[RAG Config] RAG_OPENAI_EMBEDDINGS_VIA=${raw} is not openai or openrouter; using openai`);
  }
  return 'openai';
}

/** Options for an OpenAI SDK client that only calls the embeddings endpoint. Never use it for images, audio or vision. */
export function openAiEmbeddingsClientOptions(source: OpenAiEmbeddingsEnv = env): OpenAiEmbeddingsClientOptions {
  if (openAiEmbeddingsVia(source) === 'openai') return { apiKey: source.OPENAI_API_KEY };
  const key = source.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error('[RAG Config] RAG_OPENAI_EMBEDDINGS_VIA=openrouter needs OPENROUTER_API_KEY');
  return { apiKey: key, baseURL: OPENROUTER_EMBEDDINGS_BASE_URL };
}

/** The OpenAI Batch API exists only on api.openai.com, so it is unavailable while embeddings go through OpenRouter. */
export function batchApiAllowed(source: OpenAiEmbeddingsEnv = env): boolean {
  return openAiEmbeddingsVia(source) === 'openai';
}

/** OpenRouter may answer with the vendor-prefixed id; profiles store the bare OpenAI id. */
export function normalizeOpenAiEmbeddingModel(model: string): string {
  return model.startsWith('openai/') ? model.slice('openai/'.length) : model;
}
