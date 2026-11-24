import type { EmbeddingProvider } from './types';

export interface OpenAiEmbeddingsClient {
  embeddings: {
    create(
      body: { model: string; input: string | string[] },
      opts: { signal: AbortSignal },
    ): Promise<{ data: { embedding: number[] }[]; model: string; usage?: { total_tokens?: number } }>;
  };
}

export interface OpenAiProviderOptions {
  client?: () => OpenAiEmbeddingsClient;
}

export function createOpenAiProvider(options: OpenAiProviderOptions = {}): EmbeddingProvider {
  void options;
  const empty = async () => ({ vectors: [], model: '', host: '', usage: { tokens: 0 } });
  return {
    id: 'openai',
    model: '',
    maxInputTokens: 0,
    supportedDims: [],
    normalize: true,
    embedDocuments: empty,
    embedQuery: empty,
  };
}
