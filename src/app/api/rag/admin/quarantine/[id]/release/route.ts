import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { releaseQuarantined } from '@/lib/rag';
import { invalidRequest, jsonNoStore, quarantineFailure } from '../../_responses';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });
/** The release takes no input: an actor or any other key is refused, the actor is the verified admin. */
const BodySchema = z.object({}).strict();

/** Releases one quarantined version into retrieval through the publish swap. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const raw = await request.text();
  if (raw.trim() !== '') {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
    }
    const checked = BodySchema.safeParse(body);
    if (!checked.success) {
      return invalidRequest(checked.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    }
  }

  const result = await releaseQuarantined({ documentId: parsed.data.id, actorUserId: admin.userId, signal: request.signal });
  if (!result.ok) return quarantineFailure(result.reason);
  console.log('[RAG Admin] quarantined document released', { documentId: result.documentId });
  return jsonNoStore({
    success: true,
    id: result.documentId,
    status: 'ready',
    version: result.version,
    superseded_document_id: result.supersededDocumentId,
    rule_ids: result.ruleIds,
  });
}
