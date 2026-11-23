import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requireAdminRequest } from '@/lib/admin-session';
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
