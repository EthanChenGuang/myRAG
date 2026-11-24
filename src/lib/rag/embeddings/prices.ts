import type { EmbeddingProviderId } from './types';

export interface EmbeddingPrice {
  provider: EmbeddingProviderId;
  usdPerMillionTokens: number;
  tokensAreEstimates: boolean;
}

const PRICES: Record<EmbeddingProviderId, EmbeddingPrice> = {
  openai: { provider: 'openai', usdPerMillionTokens: 0.02, tokensAreEstimates: false },
  voyage: { provider: 'voyage', usdPerMillionTokens: 0.12, tokensAreEstimates: true },
  qwen3: { provider: 'qwen3', usdPerMillionTokens: 0.01, tokensAreEstimates: true },
};

export function priceFor(provider: EmbeddingProviderId): EmbeddingPrice {
  return PRICES[provider];
}

/**
 * Non-OpenAI token counts come from a different tokenizer than the one used to count, so the
 * figure is an estimate and is labelled as such.
 */
export function estimateCostUsd(provider: EmbeddingProviderId, tokens: number): { usd: number; estimated: boolean } {
  const price = PRICES[provider];
  return { usd: (tokens * price.usdPerMillionTokens) / 1_000_000, estimated: price.tokensAreEstimates };
}
