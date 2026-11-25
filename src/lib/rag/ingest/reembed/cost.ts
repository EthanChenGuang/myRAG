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

const PROVIDERS: readonly string[] = ['openai', 'voyage', 'qwen3'];

export const ESTIMATE_NOTE =
  'Token counts are cl100k_base estimates for non-OpenAI models; the vendor bills its own count, so the cost is an estimate.';

/**
 * Prices tokens per tenant with the registry price table (embeddings/prices.ts). OpenAI counts are exact; Voyage and Qwen3 counts come from
 * another tokenizer, so the report says they are estimates.
 */
export function estimateReembedCost(provider: string, totals: Record<string, TenantTokenTotals>): ReembedCostReport {
  if (!PROVIDERS.includes(provider)) throw new Error(`[Re-embed] no price table for provider "${provider}"`);
  const id = provider as EmbeddingProviderId;
  const tenants: TenantCost[] = Object.entries(totals)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tenantKey, entry]) => ({ tenantKey, chunks: entry.chunks, tokens: entry.tokens, usd: estimateCostUsd(id, entry.tokens).usd }));
  const sum = tenants.reduce(
    (acc, tenant) => ({ chunks: acc.chunks + tenant.chunks, tokens: acc.tokens + tenant.tokens, usd: acc.usd + tenant.usd }),
    { chunks: 0, tokens: 0, usd: 0 },
  );
  const estimated = estimateCostUsd(id, 0).estimated;
  return { tenants, totals: sum, estimated, note: estimated ? ESTIMATE_NOTE : null };
}

/** Dollars to six decimals under one dollar, two decimals from one dollar up. */
export function formatUsd(usd: number): string {
  return usd >= 1 ? usd.toFixed(2) : usd.toFixed(6);
}
