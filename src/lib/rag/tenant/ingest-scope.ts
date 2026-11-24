import type { SupabaseClient } from '@supabase/supabase-js';
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
  /** The id of the admin the route guard verified. The database checks admin_users again and limits the answer to the tenants this user administers. */
  adminUserId: string;
  signal: AbortSignal;
  admin?: Pick<SupabaseClient, 'rpc'> | null;
}

/** Why the tenant of a document could not be resolved: the actor is not an admin (the database says so), or the lookup failed. */
export class AdminDocumentScopeError extends Error {
  readonly reason: 'not_admin' | 'unavailable';

  constructor(reason: 'not_admin' | 'unavailable') {
    super(`[RAG Tenant] admin document scope failed (${reason})`);
    this.name = 'AdminDocumentScopeError';
    this.reason = reason;
  }
}

const TENANT_KEY_RE = /^(?:s:default|([uo]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/;

function lower(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The tenant scope of one existing document, for the admin type change. The database returns the document's own tenant key and owner only
 * when the actor administers that tenant (the single tenant; or the actor's personal tenant and the organizations where the actor is owner or
 * admin), so a document of any other tenant reads exactly like an unknown id: null. The scope is the document's own, with the uploader as its
 * user, so a new version keeps its owner. Its only caller is the type-change route, after that route's admin guard passed. Throws
 * AdminDocumentScopeError when the actor is not in admin_users or the lookup fails.
 */
export async function scopeForAdminDocument(input: AdminDocumentScopeInput): Promise<TenantScope | null> {
  const documentId = lower(input.documentId);
  if (documentId === null) return null;
  const actor = lower(input.adminUserId);
  if (actor === null) throw new AdminDocumentScopeError('unavailable');
  const admin = input.admin === undefined ? getRagDeps().adminClient() : input.admin;
  if (!admin) throw new AdminDocumentScopeError('unavailable');

  let rows: unknown[] | null;
  try {
    input.signal.throwIfAborted();
    const response = await admin.rpc('rag_admin_document_scope', { p_document_id: documentId, p_actor: actor }).abortSignal(input.signal);
    input.signal.throwIfAborted();
    if (response.error) {
      if (/^not_admin\b/.test(response.error.message ?? '')) throw new AdminDocumentScopeError('not_admin');
      console.warn('[RAG Tenant] admin document scope refused', { reason: 'lookup_failed', code: response.error.code ?? null });
      throw new AdminDocumentScopeError('unavailable');
    }
    rows = response.data as unknown[] | null;
  } catch (error) {
    if (error instanceof AdminDocumentScopeError) throw error;
    if (input.signal.aborted) throw error;
    console.warn('[RAG Tenant] admin document scope refused', { reason: 'lookup_failed' });
    throw new AdminDocumentScopeError('unavailable');
  }

  const row = rows?.[0] as { tenant_key?: unknown; user_id?: unknown; organization_id?: unknown } | undefined;
  if (!row) return null;
  const key = typeof row.tenant_key === 'string' ? TENANT_KEY_RE.exec(row.tenant_key) : null;
  if (!key) {
    console.warn('[RAG Tenant] admin document scope refused', { reason: 'invalid_tenant_key' });
    throw new AdminDocumentScopeError('unavailable');
  }
  const userId = lower(row.user_id);
  const organizationId = lower(row.organization_id);
  try {
    if (row.tenant_key === 's:default') return mintScope('single', null, null);
    if (key[1] === 'o' && key[2] === organizationId) return mintScope('org', userId, organizationId);
    if (key[1] === 'u' && key[2] === userId && organizationId === null) return mintScope('personal', userId, null);
  } catch {
    // falls through to the refusal below
  }
  console.warn('[RAG Tenant] admin document scope refused', { reason: 'tenant_key_mismatch' });
  throw new AdminDocumentScopeError('unavailable');
}
