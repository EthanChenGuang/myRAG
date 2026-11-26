import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { currentJudgeCalibrationStatus } from '@/lib/rag/judge/calibration-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The judge floors, the running judge fingerprints, every calibration cell with its effective status, reasons and valid_until, and the
 * Config UI warnings (D-29, UI-SPEC 8.1). Read-only: the calibration changes only through the calibration tool and a pull request.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    return jsonNoStore({ success: true, ...currentJudgeCalibrationStatus() });
  } catch (error) {
    console.error('[RAG Admin] judge calibration status failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return jsonNoStore({ success: false, error: 'judge_calibration_status_unavailable' }, 500);
  }
}
