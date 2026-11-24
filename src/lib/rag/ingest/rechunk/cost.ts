export interface RechunkTenantTotals {
  chunks: number;
  tokens: number;
}

export interface RechunkCostTarget {
  profileId: string;
  provider: string;
}

export interface RechunkTenantCost {
  tenantKey: string;
  chunks: number;
  tokens: number;
  usd: number;
}

export interface RechunkCostReport {
  tenants: RechunkTenantCost[];
  totals: { chunks: number; tokens: number; usd: number };
  /** Cost per embedding profile the children are embedded for. */
  profiles: Array<{ profileId: string; provider: string; usd: number }>;
  estimated: boolean;
  note: string | null;
}

export function estimateRechunkCost(_targets: readonly RechunkCostTarget[], _totals: Record<string, RechunkTenantTotals>): RechunkCostReport {
  return { tenants: [], totals: { chunks: 0, tokens: 0, usd: 0 }, profiles: [], estimated: false, note: null };
}
