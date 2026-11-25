import { getIngestDeps } from '../deps';
import { RechunkDatabaseError, runRechunkBatch, type RechunkReport } from './run';

export interface ChunkingBuildStepOptions {
  docType?: string | null;
  deadlineMs: number;
  signal?: AbortSignal;
}

/**
 * One bounded build step for the admin route: continues the open run of the profile across every tenant (or starts one) on the
 * service-role client and stops at a document boundary once deadlineMs is spent. Call again while `more` is true.
 */
export async function runChunkingBuildStep(profileId: string, options: ChunkingBuildStepOptions): Promise<RechunkReport> {
  const db = getIngestDeps().db();
  if (!db) throw new RechunkDatabaseError('rag_rechunk_start_run', 'admin_unavailable');
  return runRechunkBatch({
    db,
    profileId,
    docType: options.docType ?? null,
    deadlineMs: options.deadlineMs,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
