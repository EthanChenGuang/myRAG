import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin, ORGANIZATION_ADMIN_ROLES } from '@/lib/admin-route-auth';
import { resolveAdminWorkspaceScope } from '@/lib/rag';
import type { TenantScope } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** No tenant key in any answer: the CLI commands carry a placeholder the operator fills in (UI-SPEC 11.7). */
export const SCOPE_CENTROIDS_COMMAND = 'npm run rag:scope-centroids -- --tenant <tenant-key>';
export const SCOPE_CALIBRATE_COMMAND = 'uv run --directory eval python -m rag_eval.calibrate scope';

export const OrganizationIdSchema = z.string().max(64).nullish();
export const ExampleIdSchema = z.string().uuid();

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function fail(status: number, error: string, details?: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore(details ? { success: false, error, details } : { success: false, error }, status);
}

export function invalid(error: z.ZodError): NextResponse {
  return fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
}

export type AdminGate = { ok: true; userId: string } | { ok: false; response: NextResponse };

/**
 * requireAdminOrDeny with the verified actor kept: the same admin_users check, the same 401, 403 and 503 bodies, failing closed when
 * verification is unavailable. The actor id is the one the guard verified, never a request field.
 */
export async function requireAdminOrDenyWithActor(request: Request): Promise<AdminGate> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return { ok: false, response: adminDenied(admin.status) };
  return { ok: true, userId: admin.userId };
}

export type Workspace = { ok: true; scope: TenantScope } | { ok: false; response: NextResponse };

/** The workspace of the verified admin: the personal or default one, or an organization honoured only for its owner or admin. */
export async function resolveWorkspace(adminUserId: string, organizationId: string | null | undefined, signal: AbortSignal): Promise<Workspace> {
  const workspace = await resolveAdminWorkspaceScope({
    adminUserId,
    requestedOrganizationId: organizationId ?? null,
    requiredOrganizationRoles: ORGANIZATION_ADMIN_ROLES,
    signal,
  });
  if (workspace.ok) return { ok: true, scope: workspace.scope };
  return { ok: false, response: fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable') };
}

/** Service failures read the same to the browser; the code stays in the one log line. */
export function unavailable(): NextResponse {
  return fail(503, 'scope_gate_unavailable');
}

export function organizationIdParam(request: Request): string | null {
  return new URL(request.url).searchParams.get('organizationId');
}
