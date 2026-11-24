import type { MembershipDb } from './membership';
import type { TenantResolveFailure } from './resolve-chat';
import type { TenantScope } from './scope';

export type IngestScopeResult = { ok: true; scope: TenantScope } | TenantResolveFailure;

export interface ResolveAdminWorkspaceScopeInput {
  adminUserId: string;
  requestedOrganizationId?: string | null;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
  admin?: MembershipDb | null;
  signal: AbortSignal;
}

export interface NangoOwnerScopeInput {
  ownerUserId: string | null | undefined;
  deploymentMode?: 'single-tenant' | 'multi-tenant';
}

export async function resolveAdminWorkspaceScope(_input: ResolveAdminWorkspaceScopeInput): Promise<IngestScopeResult> {
  return { ok: false, status: 503, reason: 'not_implemented' };
}

export function nangoOwnerScope(_input: NangoOwnerScopeInput): IngestScopeResult {
  return { ok: false, status: 503, reason: 'not_implemented' };
}
