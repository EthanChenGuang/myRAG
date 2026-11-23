import { NextResponse } from 'next/server';
import { requireRagAdmin } from '@/lib/rag';
import { ADMIN_SESSION_COOKIE, adminSessionCookieOptions, mintAdminSessionValue } from '@/lib/admin-session';

const MESSAGES: Record<number, string> = {
  401: 'You must be logged in',
  403: 'Not authorized as admin',
  503: 'Admin verification is unavailable',
};

export async function POST(request: Request) {
  try {
    const result = await requireRagAdmin({ headers: request.headers, signal: request.signal });
    if (!result.ok) {
      return NextResponse.json({ error: { message: MESSAGES[result.status] } }, { status: result.status });
    }

    const value = mintAdminSessionValue(result.userId);
    if (!value) {
      console.error('[Admin Login] session signing key unavailable');
      return NextResponse.json({ error: { message: MESSAGES[503] } }, { status: 503 });
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set({ name: ADMIN_SESSION_COOKIE, value, ...adminSessionCookieOptions() });
    return response;
  } catch (error) {
    console.error('[Admin Login] unexpected error', { name: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete(ADMIN_SESSION_COOKIE);
  return response;
}
