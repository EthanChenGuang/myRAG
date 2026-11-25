import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied } from '@/lib/admin-route-auth';
import type { RagAdminResult } from '@/lib/rag';
import { resolveAdminWorkspaceScope, scopeKey } from '@/lib/rag';
import type { ApprovalFailure } from '@/lib/rag';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const OrganizationIdSchema = z.string().max(64).nullish();
export const IdSchema = z.string().uuid();

export type Details = Array<{ path: string; message: string }>;

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function invalidRequest(details: Details): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

export function issues(error: z.ZodError): Details {
  return error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

export type Admission = { ok: true; actorUserId: string; tenantKey: string } | { ok: false; response: NextResponse };

/** The verified actor and the workspace tenant key the request may act on, or the standard denial. */
export async function admit(admin: RagAdminResult, organizationId: string | null | undefined, signal: AbortSignal): Promise<Admission> {
  if (!admin.ok) return { ok: false, response: adminDenied(admin.status) };
  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: organizationId ?? null,
    requiredOrganizationRoles: ['owner', 'admin'],
    signal,
  });
  if (!workspace.ok) {
    return { ok: false, response: jsonNoStore({ success: false, error: workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable' }, workspace.status) };
  }
  return { ok: true, actorUserId: admin.userId, tenantKey: scopeKey(workspace.scope) };
}

/**
 * Fixed answers for the reason words of the service. An unknown id and another workspace's id get the same 404 body, so ids cannot be
 * probed; a decided document gets 409 with the word the panel maps.
 */
export function approvalFailure(reason: ApprovalFailure, detail?: string, notFound = 'Document not found'): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: notFound }, 404);
    case 'not_pending':
    case 'superseded_by_newer':
      return jsonNoStore({ success: false, error: reason }, 409);
    case 'approve_failed':
    case 'reject_failed':
      return jsonNoStore(detail ? { success: false, error: reason, reason: detail } : { success: false, error: reason }, 409);
    case 'invalid_kind':
    case 'invalid_ref':
      return jsonNoStore({ success: false, error: reason }, 400);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    default:
      return jsonNoStore({ success: false, error: 'Upload approval administration is unavailable' }, 503);
  }
}

const EmptyBodySchema = z.object({}).strict();

/** The actions take no input: an actor, a document id or any other key is refused. An empty body is accepted. */
export async function refuseBody(request: Request): Promise<NextResponse | null> {
  const raw = await request.text();
  if (raw.trim() === '') return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  }
  const checked = EmptyBodySchema.safeParse(body);
  return checked.success ? null : invalidRequest(issues(checked.error));
}
