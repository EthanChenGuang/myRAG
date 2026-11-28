import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { dismissEffectiveDateProposal } from '@/lib/rag';
import { IdSchema, OrganizationIdSchema, admission, datesFailure, invalidRequest, issues, jsonNoStore, refuseBody } from '../../_lib';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ documentId: IdSchema });
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });

/** Discards an extracted proposal; the current dates stay. The actor is the verified user, never the body. */
export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }): Promise<Response> {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!query.success) return invalidRequest(issues(query.error));

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  const refused = await refuseBody(request);
  if (refused) return refused;

  const result = await dismissEffectiveDateProposal({
    documentId: parsed.data.documentId,
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
  });
  if (!result.ok) return datesFailure(result.reason);
  return jsonNoStore({ success: true, id: result.documentId, outcome: 'dismissed' });
}
