import type { NextResponse } from 'next/server';
import { adminDenied, adminWorkspaceDenied, checkAdmin, checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { getSupabaseAdmin } from '@/lib/supabase';
import { isOrganizationMember, resolveTenantScope, verifyRagUser, type RagAdminDb, type TenantScope } from '@/lib/rag';
import { fail } from './_responses';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessAdminResult =
  | { ok: true; actorId: string; scope: TenantScope; via: 'deployment_admin' | 'organization_admin' }
  | { ok: false; response: NextResponse };

function adminClient(): RagAdminDb | null {
  try {
    return getSupabaseAdmin() as RagAdminDb | null;
  } catch {
    return null;
  }
}

function denied(response: NextResponse): AccessAdminResult {
  return { ok: false, response };
}

/**
 * A verified caller who is not an admin of the named organization: 403 Forbidden when they are not a member of it at all, so the UI shows
 * the workspace message; 403 Admin access required for a member. Every failed lookup denies.
 */
async function refusalForNonAdmin(request: Request, organizationId: string, signal: AbortSignal): Promise<NextResponse> {
  const client = adminClient();
  if (!client) return adminDenied(503);
  let user;
  try {
    user = await verifyRagUser({ headers: request.headers, admin: client, signal });
  } catch {
    return adminDenied(503);
  }
  if (!user.ok) return adminDenied(user.status);
  try {
    const member = await isOrganizationMember(client, organizationId.trim().toLowerCase(), user.userId, signal);
    return member ? adminDenied(403) : fail(403, 'Forbidden');
  } catch {
    return adminDenied(503);
  }
}

/**
 * D-04, D-28: the guard of every group and member administration route. Admitted: a deployment admin (admin_users) for the workspace it
 * names, with the organization-role rule of checkAdminOrOrgAdmin in multi-tenant mode, and, in multi-tenant mode, an owner or admin of
 * exactly the named organization. Returns the verified user id, which is the actor of every write, and the workspace scope minted from
 * the verified identity and organization; nothing in the body names either.
 */
export async function requireAccessAdmin(request: Request, organizationId: string | null, signal: AbortSignal): Promise<AccessAdminResult> {
  const admitted = await checkAdminOrOrgAdmin(request, organizationId);
  if (!admitted.ok) {
    const orgRequested = typeof organizationId === 'string' && UUID_RE.test(organizationId.trim());
    if (admitted.status === 403 && admitted.reason === 'not_admin' && orgRequested && getDeploymentMode() === 'multi-tenant') {
      return denied(await refusalForNonAdmin(request, organizationId, signal));
    }
    return denied(adminWorkspaceDenied(admitted));
  }

  const resolved = await resolveTenantScope({
    requestedOrganizationId: admitted.organizationId,
    getUser: async () => ({ id: admitted.userId }),
    admin: adminClient(),
    signal,
  });
  if (!resolved.ok) return denied(resolved.status === 403 ? fail(403, 'Forbidden') : fail(503, 'Workspace verification unavailable'));
  if (!resolved.scope) return denied(fail(503, 'Workspace verification unavailable'));
  return { ok: true, actorId: admitted.userId, scope: resolved.scope, via: admitted.via };
}

export type AccessMemberResult = { ok: true; userId: string } | { ok: false; response: NextResponse };

/** GET /mine: any verified session (SSR cookie or Bearer token); no admin check. */
export async function requireAccessUser(request: Request, signal: AbortSignal): Promise<AccessMemberResult> {
  const client = adminClient();
  if (!client) return { ok: false, response: fail(503, 'access_groups_unavailable') };
  let user;
  try {
    user = await verifyRagUser({ headers: request.headers, admin: client, signal });
  } catch {
    return { ok: false, response: fail(503, 'access_groups_unavailable') };
  }
  if (!user.ok) return { ok: false, response: user.status === 401 ? fail(401, 'Authentication required') : fail(503, 'access_groups_unavailable') };
  return { ok: true, userId: user.userId };
}

/** The workspace scope of a verified user: the organization only after a membership row is found (403 Forbidden otherwise). */
export async function memberWorkspaceScope(
  userId: string,
  organizationId: string | null,
  signal: AbortSignal,
): Promise<{ ok: true; scope: TenantScope } | { ok: false; response: NextResponse }> {
  const resolved = await resolveTenantScope({ requestedOrganizationId: organizationId, getUser: async () => ({ id: userId }), admin: adminClient(), signal });
  if (!resolved.ok) return { ok: false, response: resolved.status === 403 ? fail(403, 'Forbidden') : fail(503, 'Workspace verification unavailable') };
  if (!resolved.scope) return { ok: false, response: fail(503, 'Workspace verification unavailable') };
  return { ok: true, scope: resolved.scope };
}

/**
 * A-03, D-07: the operator guard of the deployment-wide routes (status, sync, drift). Only a verified deployment admin (admin_users with a
 * live session) passes; an organization admin does not, because enforcement is the same for every workspace.
 */
export async function requireAccessOperator(request: Request): Promise<{ ok: true; actorId: string } | { ok: false; response: NextResponse }> {
  const admitted = await checkAdmin(request);
  if (!admitted.ok) return { ok: false, response: adminDenied(admitted.status) };
  return { ok: true, actorId: admitted.userId };
}
