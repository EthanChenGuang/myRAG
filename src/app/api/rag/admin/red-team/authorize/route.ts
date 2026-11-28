import { NextResponse } from 'next/server';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SEC-11: the Config UI server asks this route, with the operator's forwarded session, whether the caller is an operator admin
 * before it starts a red-team run on the operator's machine. No side effect; fails closed (401, 403, 503); same-origin only.
 */
export async function GET(request: Request): Promise<Response> {
  const result = await checkAdmin(request);
  if (!result.ok) return adminDenied(result.status);
  return NextResponse.json({ ok: true, adminId: result.userId }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
