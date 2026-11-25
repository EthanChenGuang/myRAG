import { catalogEntry, defaultModelFor } from './catalog';
import type { EmbeddingProviderId } from './types';

export interface EmbeddingPrice {
  provider: EmbeddingProviderId;
  model: string;
  usdPerMillionTokens: number;
  tokensAreEstimates: boolean;
}

/** The catalog list price of one model; the provider's default model when no model is named. */
export function priceFor(provider: EmbeddingProviderId, model?: string): EmbeddingPrice {
  const entry = catalogEntry(provider, model ?? defaultModelFor(provider) ?? '');
  if (!entry) throw new Error(`[Embedding Profile] unknown embedding model for provider ${provider}`);
  return {
    provider: entry.provider,
    model: entry.model,
    usdPerMillionTokens: entry.usdPerMillionTokens,
    tokensAreEstimates: entry.tokensAreEstimates,
  };
}

/**
 * Non-OpenAI token counts come from a different tokenizer than the one used to count, so the
 * figure is an estimate and is labelled as such. Accepts (provider, tokens) for the default model
 * or (provider, model, tokens).
 */
export function estimateCostUsd(provider: EmbeddingProviderId, tokens: number): { usd: number; estimated: boolean };
export function estimateCostUsd(provider: EmbeddingProviderId, model: string, tokens: number): { usd: number; estimated: boolean };
export function estimateCostUsd(
  provider: EmbeddingProviderId,
  modelOrTokens: string | number,
  tokens?: number,
): { usd: number; estimated: boolean } {
  const model = typeof modelOrTokens === 'string' ? modelOrTokens : undefined;
  const count = typeof modelOrTokens === 'number' ? modelOrTokens : (tokens ?? 0);
  const price = priceFor(provider, model);
  return { usd: (count * price.usdPerMillionTokens) / 1_000_000, estimated: price.tokensAreEstimates };
}
