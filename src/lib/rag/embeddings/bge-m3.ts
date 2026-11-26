import type { EmbeddingProvider } from './types';
import { BGE_M3_MODEL_ID } from './types';

export const BGE_M3_APP_INPUT_TOKEN_LIMIT = 0;

export interface BgeM3Config {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export function createBgeM3Provider(_options: { config?: () => BgeM3Config } = {}): EmbeddingProvider {
  const fail = async (): Promise<never> => {
    throw new Error('not implemented');
  };
  return {
    id: 'qwen3',
    model: BGE_M3_MODEL_ID,
    maxInputTokens: 0,
    supportedDims: [],
    normalize: true,
    embedDocuments: fail,
    embedQuery: fail,
  };
}
