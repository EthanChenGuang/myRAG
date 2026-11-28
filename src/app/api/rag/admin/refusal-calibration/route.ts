import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { currentRefusalCalibrationStatus } from '@/lib/rag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The refusal switch, the configured reranker and model per tier, every threshold cell with its point estimates and 95% upper bounds, and
 * the Config UI warnings (D-17). Read-only: thresholds change only through the calibration tool and a pull request.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    return jsonNoStore({ success: true, ...currentRefusalCalibrationStatus() });
  } catch (error) {
    console.error('[RAG Admin] refusal calibration status failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return jsonNoStore({ success: false, error: 'refusal_status_unavailable' }, 500);
  }
}
