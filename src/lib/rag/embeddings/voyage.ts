import type { EmbeddingProvider } from './types';

export interface VoyageConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface VoyageProviderOptions {
  config?: () => VoyageConfig;
}

export function splitIntoBatches(texts: string[]): string[][] {
  return [texts];
}

export function createVoyageProvider(options: VoyageProviderOptions = {}): EmbeddingProvider {
  void options;
  const empty = async () => ({ vectors: [], model: '', host: '', usage: { tokens: 0 } });
  return {
    id: 'voyage',
    model: '',
    maxInputTokens: 0,
    supportedDims: [],
    normalize: true,
    embedDocuments: empty,
    embedQuery: empty,
  };
}
