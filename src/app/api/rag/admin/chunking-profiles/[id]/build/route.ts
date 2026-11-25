import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { RechunkInputError, runChunkingBuildStep } from '@/lib/rag';
import type { RechunkReport } from '@/lib/rag';
import { DocTypeSchema, PROFILE_ID_PATTERN, chunkingUnavailable, invalidRequest, jsonNoStore, optionalJsonBody, zodDetails } from '../../_responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One step stays well inside the 60 s function limit; the run keeps its cursor and the next call continues it. */
const BUILD_STEP_DEADLINE_MS = 45_000;
/** Refusals that come from the environment (storage, the embedding registry), not from the request. */
const OPERATIONAL_REFUSALS = new Set(['object_store_unavailable', 'embedding_profile_unavailable']);

const ParamsSchema = z.object({ id: z.string().regex(PROFILE_ID_PATTERN) });
/** Only the doc type, needed when the id exists for more than one; an actor or any other key is refused. */
const BodySchema = z.object({ doc_type: DocTypeSchema.optional() }).strict();

function gapReasons(report: RechunkReport): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const gap of report.gaps) reasons[gap.reason] = (reasons[gap.reason] ?? 0) + 1;
  return reasons;
}

/** Runs one bounded runRechunkBatch step of the profile and answers progress and gap counts only (no document id or tenant key). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalidRequest(zodDetails(params.error));
  const read = await optionalJsonBody(request);
  if (!read.ok) return read.response;
  const body = BodySchema.safeParse(read.body);
  if (!body.success) return invalidRequest(zodDetails(body.error));

  const profileId = params.data.id;
  let report: RechunkReport;
  try {
    report = await runChunkingBuildStep(profileId, {
      ...(body.data.doc_type ? { docType: body.data.doc_type } : {}),
      deadlineMs: BUILD_STEP_DEADLINE_MS,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) {
      console.warn('[RAG Admin] chunking profile action aborted', { action: 'build', profileId });
      return jsonNoStore({ success: false, error: 'build_aborted' }, 499);
    }
    if (error instanceof RechunkInputError && !OPERATIONAL_REFUSALS.has(error.code)) {
      console.warn('[RAG Admin] chunking profile action refused', { action: 'build', profileId, reason: error.code });
      if (error.code === 'unknown_profile') return jsonNoStore({ success: false, error: 'profile_not_found' }, 404);
      return jsonNoStore({ success: false, error: 'build_refused', reason: error.code }, 409);
    }
    return chunkingUnavailable('build', profileId, error);
  }

  console.log('[RAG Admin] chunking profile action', {
    action: 'build',
    profileId,
    actor: admin.userId,
    status: report.status,
    docsDone: report.docsDone,
    docsTotal: report.docsTotal,
    gaps: report.gaps.length,
  });
  return jsonNoStore({
    success: true,
    run_id: report.runId,
    status: report.status,
    docsDone: report.docsDone,
    docsTotal: report.docsTotal,
    gaps: report.gaps.length,
    gap_reasons: gapReasons(report),
    more: report.more,
  });
}
