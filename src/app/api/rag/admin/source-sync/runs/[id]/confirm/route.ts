import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { confirmReconcileRun } from '@/lib/nango/source-sync-admin';
import { invalidRequest, issuesOf, jsonNoStore, readJsonBody, sourceSyncFailure } from '../../../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });
/** The confirmation takes no input: an actor or any other key is refused, the actor is the verified admin. */
const BodySchema = z.object({}).strict();

/** Removes the candidates of a paused run in the connection's deletion mode (D-09); refused after 24 hours. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issuesOf(parsed.error));
  const body = await readJsonBody(request);
  if (!body.ok) return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  if (body.body !== undefined) {
    const checked = BodySchema.safeParse(body.body);
    if (!checked.success) return invalidRequest(issuesOf(checked.error));
  }

  const result = await confirmReconcileRun({ runId: parsed.data.id, actorUserId: admin.userId, signal: request.signal });
  if (!result.ok) return sourceSyncFailure(result.reason);
  console.log('[RAG Admin] source sync run confirmed', { runId: result.runId, removed: result.removed, failed: result.failed });
  return jsonNoStore({ success: true, removed: result.removed, failed: result.failed });
}
