import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { validateRequest } from '@/lib/api-middleware';
import { listVectorSyncTargets, resolveVectorSyncAdminRpc, setVectorSyncTarget } from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SetTargetSchema = z.object({ target: z.enum(['weaviate', 'qdrant']), enabled: z.boolean() }).strict();

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function logFailure(action: 'read' | 'set', error: unknown): void {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
  console.error(`[RAG Admin] vector sync targets ${action} failed`, { code });
}

/** D-24: the enabled flag of both sync targets. Admin only; fails closed. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const rpc = resolveVectorSyncAdminRpc();
  if (!rpc) return jsonNoStore({ success: false, error: 'vector_sync_unavailable' }, 503);
  try {
    return jsonNoStore({ success: true, targets: await listVectorSyncTargets(rpc) });
  } catch (error) {
    logFailure('read', error);
    return jsonNoStore({ success: false, error: 'vector_sync_targets_failed' }, 500);
  }
}

/** D-24: turns one sync target on or off with the admin's id as the audit actor; a first enable enqueues every tenant. */
export async function PUT(request: NextRequest): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = await validateRequest(request, SetTargetSchema);
  if (!parsed.success) return parsed.response;

  const rpc = resolveVectorSyncAdminRpc();
  if (!rpc) return jsonNoStore({ success: false, error: 'vector_sync_unavailable' }, 503);
  try {
    const result = await setVectorSyncTarget(rpc, parsed.data.target, parsed.data.enabled, admin.userId);
    return jsonNoStore({ success: true, ...result });
  } catch (error) {
    logFailure('set', error);
    return jsonNoStore({ success: false, error: 'vector_sync_targets_failed' }, 500);
  }
}
