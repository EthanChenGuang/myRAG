import type { EmbeddingProviderId } from './types';

export interface EmbeddingPrice {
  provider: EmbeddingProviderId;
  usdPerMillionTokens: number;
  tokensAreEstimates: boolean;
}

export function priceFor(provider: EmbeddingProviderId): EmbeddingPrice {
  return { provider, usdPerMillionTokens: 0, tokensAreEstimates: false };
}

export function estimateCostUsd(provider: EmbeddingProviderId, tokens: number): { usd: number; estimated: boolean } {
  void provider;
  void tokens;
  return { usd: 0, estimated: false };
}
