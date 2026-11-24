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

export function estimateReembedCost(_provider: string, _totals: Record<string, TenantTokenTotals>): ReembedCostReport {
  return { tenants: [], totals: { chunks: 0, tokens: 0, usd: 0 }, estimated: false, note: null };
}

export function formatUsd(_usd: number): string {
  return '';
}
