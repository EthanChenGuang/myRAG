import { getDeploymentMode } from '@/lib/deployment-mode';
import { getRagDeps } from '../deps';
import { isOrganizationMember, type MembershipDb } from './membership';
import type { TenantResolveFailure } from './resolve-chat';
import { mintScope, type TenantScope } from './scope';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(label: string, status: 403 | 503, reason: string): TenantResolveFailure {
  console.warn(`[RAG Tenant] ${label} refused`, { reason });
  return { ok: false, status, reason };
}

function wantsPersonal(requested: unknown): boolean {
  return requested === undefined || requested === null || requested === '' || requested === 'null';
}

/**
 * Scope for a Config UI upload. The caller is an admin already verified by the admin guard; the workspace
 * is the one the admin selected, honoured only after an organization_members row for that admin is found.
 * Ids are lowercased once here so the scope key, the query and the logs agree.
 */
export async function resolveAdminWorkspaceScope(input: ResolveAdminWorkspaceScopeInput): Promise<IngestScopeResult> {
  const mode = input.deploymentMode ?? getDeploymentMode();
  if (mode !== 'multi-tenant') return { ok: true, scope: mintScope('single', null, null) };

  const label = 'admin workspace scope';
  if (typeof input.adminUserId !== 'string' || !UUID_RE.test(input.adminUserId)) {
    return refuse(label, 503, 'invalid_user');
  }
  const adminId = input.adminUserId.toLowerCase();

  const requested = input.requestedOrganizationId;
  if (wantsPersonal(requested)) return { ok: true, scope: mintScope('personal', adminId, null) };
  if (typeof requested !== 'string' || !UUID_RE.test(requested.trim())) {
    return refuse(label, 403, 'invalid_organization');
  }
  const organizationId = requested.trim().toLowerCase();

  const admin = input.admin === undefined ? getRagDeps().adminClient() : input.admin;
  if (!admin) return refuse(label, 503, 'membership_unavailable');

  let member: boolean;
  try {
    member = await isOrganizationMember(admin, organizationId, adminId, input.signal);
  } catch {
    return refuse(label, 503, 'membership_unavailable');
  }
  if (!member) return refuse(label, 403, 'not_member');
  return { ok: true, scope: mintScope('org', adminId, organizationId) };
}

/**
 * Scope for a Nango sync. ownerUserId is the user_id of the server-side nango_connections row the caller read
 * by connection_id (unique per connection); it is never taken from a request or a webhook value.
 */
export function nangoOwnerScope(input: NangoOwnerScopeInput): IngestScopeResult {
  const mode = input.deploymentMode ?? getDeploymentMode();
  if (mode !== 'multi-tenant') return { ok: true, scope: mintScope('single', null, null) };

  const owner = input.ownerUserId;
  if (typeof owner !== 'string' || !UUID_RE.test(owner)) return refuse('nango owner scope', 503, 'invalid_owner');
  return { ok: true, scope: mintScope('personal', owner.toLowerCase(), null) };
}

export interface AdminDocumentScopeInput {
  documentId: string;
  adminUserId: string;
  signal: AbortSignal;
}

export class AdminDocumentScopeError extends Error {
  readonly reason: 'not_admin' | 'unavailable';

  constructor(reason: 'not_admin' | 'unavailable') {
    super(`[RAG Tenant] admin document scope failed (${reason})`);
    this.name = 'AdminDocumentScopeError';
    this.reason = reason;
  }
}

export async function scopeForAdminDocument(_input: AdminDocumentScopeInput): Promise<TenantScope | null> {
  return null;
}
