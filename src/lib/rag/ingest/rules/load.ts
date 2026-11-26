import type { TenantScope } from '../../tenant/scope';

export interface TenantRuleBinding {
  docType: string | null;
  source: string | null;
}

export const TENANT_RULE_CACHE = { ttlMs: 60_000, failureTtlMs: 5_000, maxTenants: 256, maxBindingsPerTenant: 64 } as const;

export function invalidateTenantRules(_tenantKey: string): void {}

export function resetTenantRuleCacheForTests(): void {}

export async function loadTenantRules(_scope: TenantScope, _binding: TenantRuleBinding, _options: { signal?: AbortSignal } = {}): Promise<never> {
  throw new Error('not implemented');
}
