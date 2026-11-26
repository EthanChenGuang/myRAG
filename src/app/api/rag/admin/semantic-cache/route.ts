import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { validateRequest } from '@/lib/api-middleware';
import { clearTenantSemanticCache } from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ClearCacheSchema = z.object({ tenantKey: z.string().min(1).max(64) }).strict();

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** D-44: deletes one tenant's semantic cache entries. Admin only; fails closed. */
export async function POST(request: NextRequest): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const parsed = await validateRequest(request, ClearCacheSchema);
  if (!parsed.success) {
    return jsonNoStore({ success: false, error: 'invalid_request' }, 400);
  }

  try {
    const result = await clearTenantSemanticCache(parsed.data.tenantKey, { signal: request.signal });
    if (!result.ok) return jsonNoStore({ success: false, error: result.error }, result.status);
    return jsonNoStore({ success: true, deleted: result.deleted, backend: result.backend });
  } catch (error) {
    console.error('[Semantic Cache] tenant clear failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return jsonNoStore({ success: false, error: 'semantic_cache_unavailable' }, 503);
  }
}
