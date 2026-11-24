import type { EmbeddingProvider } from './types';

export const QWEN_QUERY_TASK = 'Given a web search query, retrieve relevant passages that answer the query';

export interface QwenHostConfig {
  apiKey: string;
  baseUrl: string;
}

export interface QwenConfig {
  deepinfra: QwenHostConfig;
  openrouter: QwenHostConfig;
  fallback: 'openrouter' | 'none';
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface QwenProviderOptions {
  config?: () => QwenConfig;
}

export function createQwenProvider(options: QwenProviderOptions = {}): EmbeddingProvider {
  void options;
  const empty = async () => ({ vectors: [], model: '', host: '', usage: { tokens: 0 } });
  return {
    id: 'qwen3',
    model: '',
    maxInputTokens: 0,
    supportedDims: [],
    normalize: true,
    embedDocuments: empty,
    embedQuery: empty,
  };
}
