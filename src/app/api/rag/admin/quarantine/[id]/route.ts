import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { deleteQuarantined } from '@/lib/rag';
import { invalidRequest, jsonNoStore, quarantineFailure } from '../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });

/** Deletes one quarantined version and its stored objects. The actor is the admin the guard verified. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const result = await deleteQuarantined({ documentId: parsed.data.id, actorUserId: admin.userId, signal: request.signal });
  if (!result.ok) return quarantineFailure(result.reason);
  console.log('[RAG Admin] quarantined document deleted', { documentId: result.documentId });
  if (result.artifactsFailed > 0) return jsonNoStore({ success: true, artifacts_failed: result.artifactsFailed });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
