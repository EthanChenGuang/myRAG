import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { setDeletionMode } from '@/lib/nango/source-sync-admin';
import { invalidRequest, issuesOf, jsonNoStore, readJsonBody, sourceSyncFailure } from '../../../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({ mode: z.enum(['soft', 'purge']).nullable() }).strict();

/** Sets the connection's deletion mode (D-08): null keeps the default path. Future deletions only; nothing is purged now. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issuesOf(parsed.error));
  const body = await readJsonBody(request);
  if (!body.ok) return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  const checked = BodySchema.safeParse(body.body);
  if (!checked.success) return invalidRequest(issuesOf(checked.error));

  const result = await setDeletionMode({ connectionId: parsed.data.id, mode: checked.data.mode, actorUserId: admin.userId, signal: request.signal });
  if (!result.ok) return sourceSyncFailure(result.reason);
  console.log('[RAG Admin] source sync deletion mode set', { connectionId: result.connectionId, mode: result.mode ?? 'default' });
  return jsonNoStore({ success: true, id: result.connectionId, deletion_mode: result.mode });
}
