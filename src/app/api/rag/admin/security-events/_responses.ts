import { NextResponse } from 'next/server';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyRagUser, type RagAdminDb } from '@/lib/rag';
import { resolveAdminTenants, type SecurityActor, type SecurityAdminDb, type SecurityFailure } from '@/lib/rag/security/security-admin';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function invalidRequest(details: Array<{ path: string; message: string }>): NextResponse {
  return jsonNoStore({ success: false, error: 'Invalid request data', details }, 400);
}

export function zodDetails(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Another tenant's row and an unknown id give the same 404, so ids are not probed (UI-SPEC 8.2). */
export function securityFailure(reason: SecurityFailure): NextResponse {
  switch (reason) {
    case 'not_found':
      return jsonNoStore({ success: false, error: 'not_found' }, 404);
    case 'hold_disabled':
    case 'already_held':
    case 'not_held':
    case 'already_acknowledged':
      return jsonNoStore({ success: false, error: reason }, 409);
    default:
      return jsonNoStore({ success: false, error: 'Security administration is unavailable' }, 503);
  }
}

export type SecurityAdmission = { ok: true; actor: SecurityActor; db: SecurityAdminDb } | { ok: false; response: NextResponse };

/**
 * D-47 admission, first in every route: a verified deployment admin (checkAdmin) acts on every tenant; otherwise a signed-in user acts on
 * the tenants the database names for them (organization owner or admin, or granted domain expert). No tenant means the standard denial.
 */
export async function admitSecurityActor(request: Request, options: { deploymentAdminOnly?: boolean } = {}): Promise<SecurityAdmission> {
  const admin = await checkAdmin(request);
  let db: SecurityAdminDb | null;
  try {
    db = getSupabaseAdmin() as unknown as SecurityAdminDb | null;
  } catch {
    db = null;
  }
  let userId: string;
  let deploymentAdmin: boolean;
  if (admin.ok) {
    userId = admin.userId;
    deploymentAdmin = true;
  } else {
    if (admin.status !== 403 || admin.reason !== 'not_admin' || options.deploymentAdminOnly) return { ok: false, response: adminDenied(admin.status) };
    if (!db) return { ok: false, response: adminDenied(503) };
    let user;
    try {
      user = await verifyRagUser({ headers: request.headers, admin: db as unknown as RagAdminDb, signal: request.signal });
    } catch {
      return { ok: false, response: adminDenied(503) };
    }
    if (!user.ok) return { ok: false, response: adminDenied(user.status) };
    userId = user.userId;
    deploymentAdmin = false;
  }
  if (!db) return { ok: false, response: adminDenied(503) };
  const keys = await resolveAdminTenants(db, { userId, deploymentAdmin });
  if (!keys.ok) return { ok: false, response: adminDenied(503) };
  if (!deploymentAdmin && keys.tenantKeys.length === 0) return { ok: false, response: adminDenied(403) };
  return { ok: true, actor: { userId, deploymentAdmin, tenantKeys: keys.tenantKeys }, db };
}

const CURSOR_RE = /^\d{1,7}$/;

/** The offset cursor of the lists: a decimal row offset as the previous page returned it. */
export function cursorOffset(cursor: string | undefined): number {
  return cursor !== undefined && CURSOR_RE.test(cursor) ? Number(cursor) : 0;
}

export const CURSOR_PATTERN = CURSOR_RE;
