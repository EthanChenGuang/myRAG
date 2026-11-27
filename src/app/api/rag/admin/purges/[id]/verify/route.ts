import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { reverifyPurgeAsAdmin } from '@/lib/rag';
import { checkBody, invalidRequest, jsonNoStore, purgeFailure } from '../../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });

/** Runs the check of one purge record again and stores it (D-16). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const result = await reverifyPurgeAsAdmin({ auditId: parsed.data.id, actorUserId: admin.userId, signal: request.signal });
  if (!result.ok) return purgeFailure(result.reason);
  console.log('[RAG Admin] purge check run again', { recordId: result.auditId, result: result.check.result, pendingFiles: result.check.pendingFiles });
  return jsonNoStore({ success: true, record_id: result.auditId, check: checkBody(result.check), checked_at: result.check.checkedAt });
}
