import type { TenantScope } from './scope';
import type { MembershipDb } from './membership';

export type TenantResolveFailure = { ok: false; status: 401 | 403 | 503; reason: string };
export type TenantResolveResult =
  | { ok: true; scope: TenantScope | null; reason?: 'no_tenant' }
  | TenantResolveFailure;

export interface ResolveTenantScopeInput {
  requestedOrganizationId?: string | null;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  getUser?: () => Promise<{ id: string } | null>;
  admin?: MembershipDb | null;
  signal: AbortSignal;
}

export async function resolveTenantScope(_input: ResolveTenantScopeInput): Promise<TenantResolveResult> {
  return { ok: false, status: 503, reason: 'not_implemented' };
}
