import { z } from 'zod/v3';
import { checkAdmin } from '@/lib/admin-route-auth';
import { rejectUpload } from '@/lib/rag';
import { IdSchema, OrganizationIdSchema, admit, approvalFailure, invalidRequest, issues, jsonNoStore, refuseBody } from '../../_lib';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: IdSchema });
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });

/** Rejects one held upload through the soft delete. The actor is the verified user, never the body. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admission = await admit(await checkAdmin(request), query.success ? query.data.organizationId : null, request.signal);
  if (!admission.ok) return admission.response;
  if (!query.success) return invalidRequest(issues(query.error));

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  const refused = await refuseBody(request);
  if (refused) return refused;

  const result = await rejectUpload({
    documentId: parsed.data.id,
    actorUserId: admission.actorUserId,
    tenantKey: admission.tenantKey,
    signal: request.signal,
  });
  if (!result.ok) return approvalFailure(result.reason, result.detail);
  console.log('[RAG Admin] upload rejected', { documentId: result.documentId, version: result.version });
  return jsonNoStore({ success: true, id: result.documentId, outcome: result.outcome, status: 'deleted', version: result.version });
}
