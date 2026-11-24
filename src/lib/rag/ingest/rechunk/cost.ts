import { estimateReembedCost, type TenantTokenTotals } from '../reembed/cost';

export type RechunkTenantTotals = TenantTokenTotals;

export interface RechunkCostTarget {
  profileId: string;
  provider: string;
}

export interface RechunkTenantCost {
  tenantKey: string;
  chunks: number;
  tokens: number;
  /** The cost of embedding the tenant's children for every target profile together. */
  usd: number;
}

export interface RechunkCostReport {
  tenants: RechunkTenantCost[];
  totals: { chunks: number; tokens: number; usd: number };
  /** The cost of the whole run per embedding profile the children are embedded for. */
  profiles: Array<{ profileId: string; provider: string; usd: number }>;
  /** True when a target's vendor counts with its own tokenizer, so the dollar figure is an estimate. */
  estimated: boolean;
  note: string | null;
}

/**
 * What embedding the children of a rebuild costs: the cl100k_base tokens per tenant priced with the Phase 3 price table once for every
 * embedding profile the children are embedded for (the active and the backfilling ones). The totals count each child once; the dollars add up
 * over the target profiles.
 */
export function estimateRechunkCost(targets: readonly RechunkCostTarget[], totals: Record<string, RechunkTenantTotals>): RechunkCostReport {
  const perTenant = new Map<string, RechunkTenantCost>();
  const profiles: RechunkCostReport['profiles'] = [];
  let estimated = false;
  let note: string | null = null;

  for (const target of targets) {
    const report = estimateReembedCost(target.provider, totals);
    profiles.push({ profileId: target.profileId, provider: target.provider, usd: report.totals.usd });
    estimated ||= report.estimated;
    note ??= report.note;
    for (const tenant of report.tenants) {
      const entry = perTenant.get(tenant.tenantKey) ?? { tenantKey: tenant.tenantKey, chunks: tenant.chunks, tokens: tenant.tokens, usd: 0 };
      entry.usd += tenant.usd;
      perTenant.set(tenant.tenantKey, entry);
    }
  }
  if (targets.length === 0) {
    for (const [tenantKey, entry] of Object.entries(totals)) perTenant.set(tenantKey, { tenantKey, chunks: entry.chunks, tokens: entry.tokens, usd: 0 });
  }

  const tenants = [...perTenant.values()].sort((a, b) => (a.tenantKey < b.tenantKey ? -1 : a.tenantKey > b.tenantKey ? 1 : 0));
  const sum = tenants.reduce(
    (acc, tenant) => ({ chunks: acc.chunks + tenant.chunks, tokens: acc.tokens + tenant.tokens, usd: acc.usd + tenant.usd }),
    { chunks: 0, tokens: 0, usd: 0 },
  );
  return { tenants, totals: sum, profiles, estimated, note };
}
