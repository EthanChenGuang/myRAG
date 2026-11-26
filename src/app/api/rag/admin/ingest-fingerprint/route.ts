import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { computeFingerprintCoverage, listRebuildRuns } from '@/lib/rag';
import { fingerprintUnavailable, jsonNoStore } from './_responses';
import { rebuildRow } from './rebuild/_rows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET: under the saved settings, the current ready documents left on previous settings per rebuild mechanism and doc type, how each rebuild
 * starts (`ui`, `cli`, `needs_async`) with its fixed command, the documents without a fingerprint with the backfill command, and the rebuild
 * runs (id, mechanism, done, total, gaps, state, started time, activation). Counts only.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  try {
    const coverage = await computeFingerprintCoverage({ signal: request.signal });
    const rebuilds = (await listRebuildRuns({ signal: request.signal })).map(rebuildRow);
    console.log('[RAG Admin] ingest fingerprint coverage', {
      pending: coverage.pending.reduce((sum, row) => sum + row.affected, 0),
      without: coverage.without_fingerprint.count,
      rebuilds: rebuilds.length,
    });
    return jsonNoStore({ success: true, ...coverage, rebuilds });
  } catch (error) {
    return fingerprintUnavailable('coverage', error);
  }
}
