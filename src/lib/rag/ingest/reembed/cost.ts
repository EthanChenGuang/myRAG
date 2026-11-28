import { estimateCostUsd } from '../../embeddings/prices';
import type { EmbeddingProviderId } from '../../embeddings/types';

export interface TenantTokenTotals {
  chunks: number;
  tokens: number;
}

export interface TenantCost {
  tenantKey: string;
  chunks: number;
  tokens: number;
  usd: number;
}

export interface ReembedCostReport {
  tenants: TenantCost[];
  totals: { chunks: number; tokens: number; usd: number };
  /** True when the token counts are estimates because the vendor counts with its own tokenizer. */
  estimated: boolean;
  note: string | null;
}

const PROVIDERS: readonly string[] = ['openai', 'voyage', 'qwen3', 'ft_slot_a', 'ft_slot_b'];
const SLOT_PROVIDERS: readonly string[] = ['ft_slot_a', 'ft_slot_b'];

export const SLOT_NOTE =
  'A fine-tune slot is served by the operator\'s own endpoint and has no list price; the figure is 0 USD and excludes the serving cost.';

export const ESTIMATE_NOTE =
  'Token counts are cl100k_base estimates for non-OpenAI models; the vendor bills its own count, so the cost is an estimate.';

/**
 * Prices tokens per tenant with the catalog price of the run's model (embeddings/prices.ts); the provider's
 * default model when none is given. OpenAI counts are exact; Voyage and Qwen3 counts come from another
 * tokenizer, so the report says they are estimates.
 */
export function estimateReembedCost(provider: string, totals: Record<string, TenantTokenTotals>, model?: string): ReembedCostReport {
  if (!PROVIDERS.includes(provider)) throw new Error(`[Re-embed] no price table for provider "${provider}"`);
  const id = provider as EmbeddingProviderId;
  const price = (tokens: number) => (model === undefined ? estimateCostUsd(id, tokens) : estimateCostUsd(id, model, tokens));
  const tenants: TenantCost[] = Object.entries(totals)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tenantKey, entry]) => ({ tenantKey, chunks: entry.chunks, tokens: entry.tokens, usd: price(entry.tokens).usd }));
  const sum = tenants.reduce(
    (acc, tenant) => ({ chunks: acc.chunks + tenant.chunks, tokens: acc.tokens + tenant.tokens, usd: acc.usd + tenant.usd }),
    { chunks: 0, tokens: 0, usd: 0 },
  );
  const estimated = price(0).estimated;
  const note = SLOT_PROVIDERS.includes(provider) ? SLOT_NOTE : estimated ? ESTIMATE_NOTE : null;
  return { tenants, totals: sum, estimated, note };
}

/** Dollars to six decimals under one dollar, two decimals from one dollar up. */
export function formatUsd(usd: number): string {
  return usd >= 1 ? usd.toFixed(2) : usd.toFixed(6);
}
