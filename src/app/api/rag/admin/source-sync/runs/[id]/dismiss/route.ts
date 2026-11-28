import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { dismissReconcileRun } from '@/lib/nango/source-sync-admin';
import { invalidRequest, issuesOf, jsonNoStore, readJsonBody, sourceSyncFailure } from '../../../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({}).strict();

/** Dismisses a paused run; nothing is removed and the next reconcile evaluates again (D-09). */
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

  const result = await dismissReconcileRun({ runId: parsed.data.id, actorUserId: admin.userId, signal: request.signal });
  if (!result.ok) return sourceSyncFailure(result.reason);
  console.log('[RAG Admin] source sync run dismissed', { runId: result.runId, status: result.status });
  return jsonNoStore({ success: true, status: result.status });
}
