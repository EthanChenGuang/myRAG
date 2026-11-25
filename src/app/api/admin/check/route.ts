import { NextResponse } from 'next/server';
import { requireAdminCookie } from '@/lib/admin-session';

export async function GET(request: Request) {
  try {
    const result = await requireAdminCookie({ headers: request.headers, signal: request.signal });
    if (result.ok) return NextResponse.json({ isAdmin: true });
    if (result.status === 503) {
      console.error('[Admin Check] admin lookup unavailable', { reason: result.reason });
      return NextResponse.json({ isAdmin: false }, { status: 503 });
    }
    return NextResponse.json({ isAdmin: false });
  } catch (error) {
    console.error('[Admin Check] unexpected error', { name: error instanceof Error ? error.name : 'unknown' });
    return NextResponse.json({ isAdmin: false }, { status: 500 });
  }
}
