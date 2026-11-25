import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { ChunkingReportInvalid, getChunkingDecisions, getChunkingSweepReport } from '@/lib/rag';
import { jsonNoStore } from '../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The committed chunking sweep report and the recorded decisions, both validated with the generated schemas (CHK-05, F-21). */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    return jsonNoStore({ success: true, report: getChunkingSweepReport(), decisions: getChunkingDecisions() });
  } catch (error) {
    const code = error instanceof ChunkingReportInvalid ? error.code : 'chunking_report_unavailable';
    console.error('[RAG Admin] chunking report unreadable', { code });
    return jsonNoStore({ success: false, error: code }, 500);
  }
}
