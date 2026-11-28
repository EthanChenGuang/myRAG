import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { decideTerminologyCandidate } from '@/lib/rag';
import { CandidateDecisionBodySchema, TAG, fail, failure, invalid, ok, readJson } from '../../_lib';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const IdSchema = z.string().uuid();

/**
 * D-26, D-06: dismisses a pending candidate, or accepts it with the id of an entry created through the normal create route in the
 * candidate's tenant layer or the shared layer. The actor is the verified admin; the SQL resolves the tenant and writes the audit row.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const id = IdSchema.safeParse((await context.params).id);
  if (!id.success) return fail(404, 'Not found');
  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = CandidateDecisionBodySchema.safeParse(json.body);
  if (!parsed.success) return invalid(parsed.error);

  const result = await decideTerminologyCandidate({
    actorUserId: admin.userId,
    candidateId: id.data.toLowerCase(),
    action: parsed.data.action,
    entryId: parsed.data.entry_id?.toLowerCase() ?? null,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  console.log(`${TAG} terminology candidate decided`, { action: parsed.data.action, status: result.status });
  return ok({ candidate_id: result.candidateId, status: result.status, entry_id: result.entryId });
}
