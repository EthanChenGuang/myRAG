import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { computeFingerprintCoverage } from '@/lib/rag';
import { fingerprintUnavailable, jsonNoStore } from './_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET: under the saved settings, the current ready documents left on previous settings per rebuild mechanism and doc type, how each rebuild
 * starts (`ui`, `cli`, `needs_async`) with its fixed command, and the documents without a fingerprint with the backfill command. Counts only.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  try {
    const coverage = await computeFingerprintCoverage({ signal: request.signal });
    console.log('[RAG Admin] ingest fingerprint coverage', {
      pending: coverage.pending.reduce((sum, row) => sum + row.affected, 0),
      without: coverage.without_fingerprint.count,
    });
    return jsonNoStore({ success: true, ...coverage });
  } catch (error) {
    return fingerprintUnavailable('coverage', error);
  }
}
