import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdminRequest } from '@/lib/admin-session';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { isOrganizationMember, resolveAdminWorkspaceScope, scopeKey, verifyRagUser } from '@/lib/rag';
import type { RagAdminDb, RagAdminResult } from '@/lib/rag';

const MESSAGES: Record<401 | 403 | 503, string> = {
  401: 'Admin authentication required',
  403: 'Admin access required',
  503: 'Admin verification is unavailable',
};

export function adminDenied(status: 401 | 403 | 503): NextResponse {
  return NextResponse.json(
    { success: false, error: MESSAGES[status] },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function checkAdmin(request: Request): Promise<RagAdminResult> {
  let admin: RagAdminDb | null;
  try {
    admin = getSupabaseAdmin() as RagAdminDb | null;
  } catch {
    return { ok: false, status: 503, reason: 'admin_check_unavailable' };
  }
  try {
    return await requireAdminRequest({ headers: request.headers, signal: request.signal, admin });
  } catch {
    return { ok: false, status: 503, reason: 'auth_unavailable' };
  }
}

/** Returns a 401/403/503 response when the caller is not a verified admin, or null when the request may proceed. */
export async function requireAdminOrDeny(request: Request): Promise<NextResponse | null> {
  const result = await checkAdmin(request);
  return result.ok ? null : adminDenied(result.status);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The organization roles that administer an organization's tenant: the rule rag_admin_tenant_keys and rag_upload_approval_keys apply. */
export const ORGANIZATION_ADMIN_ROLES = ['owner', 'admin'] as const;

export type AdminWorkspaceResult =
  | {
      ok: true;
      userId: string;
      via: 'deployment_admin' | 'organization_admin';
      /** The one workspace the caller was admitted for: s:default, the admin's own u: key, or the named organization's o: key. */
      tenantKey: string;
      organizationId: string | null;
    }
  | { ok: false; status: 401 | 403 | 503; reason: string };

function organizationIdOf(value: string | null | undefined): string | null | 'invalid' {
  if (value === undefined || value === null || value === '' || value === 'null') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : 'invalid';
}

/**
 * Guard of the routes that D-50 opens to organization admins (upload approvals, scope vocabulary, supersession). A deployment admin
 * (checkAdmin) is admitted for the workspace it names, with the same organization rule as the ingest-jobs routes. Otherwise, in
 * multi-tenant mode only, a verified user who is an owner or admin of exactly the named organization is admitted for that organization's
 * tenant. Every lookup failure denies; the SQL functions check the actor again and stay the final authority.
 * Failure reasons: workspace_forbidden and workspace_unavailable for a deployment admin's workspace, else the admin guard's reasons.
 */
export async function checkAdminOrOrgAdmin(request: Request, organizationId: string | null | undefined): Promise<AdminWorkspaceResult> {
  const mode = getDeploymentMode();
  const requested = organizationIdOf(organizationId);
  const admin = await checkAdmin(request);
  if (admin.ok) {
    if (requested === 'invalid') return { ok: false, status: 403, reason: 'workspace_forbidden' };
    const workspace = await resolveAdminWorkspaceScope({
      adminUserId: admin.userId,
      requestedOrganizationId: requested,
      requiredOrganizationRoles: ORGANIZATION_ADMIN_ROLES,
      deploymentMode: mode,
      signal: request.signal,
    });
    if (!workspace.ok) {
      return workspace.status === 403
        ? { ok: false, status: 403, reason: 'workspace_forbidden' }
        : { ok: false, status: 503, reason: 'workspace_unavailable' };
    }
    return {
      ok: true,
      userId: admin.userId,
      via: 'deployment_admin',
      tenantKey: scopeKey(workspace.scope),
      organizationId: workspace.scope.kind === 'org' ? workspace.scope.organizationId : null,
    };
  }
  if (admin.status !== 403 || admin.reason !== 'not_admin' || mode !== 'multi-tenant') return admin;
  if (requested === null || requested === 'invalid') return admin;

  let client: RagAdminDb | null;
  try {
    client = getSupabaseAdmin() as RagAdminDb | null;
  } catch {
    return { ok: false, status: 503, reason: 'admin_check_unavailable' };
  }
  if (!client) return { ok: false, status: 503, reason: 'admin_check_unavailable' };
  let user: RagAdminResult;
  try {
    user = await verifyRagUser({ headers: request.headers, admin: client, signal: request.signal });
  } catch {
    return { ok: false, status: 503, reason: 'auth_unavailable' };
  }
  if (!user.ok) return user;
  let member: boolean;
  try {
    member = await isOrganizationMember(client, requested, user.userId, request.signal, ORGANIZATION_ADMIN_ROLES);
  } catch {
    return { ok: false, status: 503, reason: 'membership_unavailable' };
  }
  if (!member) return { ok: false, status: 403, reason: 'not_admin' };
  return { ok: true, userId: user.userId, via: 'organization_admin', tenantKey: `o:${requested}`, organizationId: requested };
}

/** The response for a failed checkAdminOrOrgAdmin: 403 Forbidden for a deployment admin's workspace, else the standard denial. */
export function adminWorkspaceDenied(result: Extract<AdminWorkspaceResult, { ok: false }>): NextResponse {
  if (result.reason === 'workspace_forbidden') {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (result.reason === 'workspace_unavailable') {
    return NextResponse.json({ success: false, error: 'Workspace verification unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return adminDenied(result.status);
}
