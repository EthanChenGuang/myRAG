import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { readIndexCompat } from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * D-16: the index-compatibility warnings and per-target sync counts for the Config UI. Admin only; fails closed. Counts, profile ids
 * and codes only, never a tenant key, chunk id, URL or key. envLoadedAt is when this process loaded its configuration (D-15 caveat).
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const view = await readIndexCompat();
    if (!view) return jsonNoStore({ success: false, error: 'index_compat_unavailable' }, 503);
    return jsonNoStore({ success: true, ...view });
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
    console.error('[RAG Admin] index compat read failed', { error: error instanceof Error ? error.name : 'unknown', code });
    return jsonNoStore({ success: false, error: 'index_compat_unavailable' }, 503);
  }
}
