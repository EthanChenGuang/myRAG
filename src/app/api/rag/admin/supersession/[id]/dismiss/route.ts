import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { dismissSupersession } from '@/lib/rag';
import { IdSchema, OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, refuseBody, supersessionFailure } from '../../_lib';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: IdSchema });
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });

/** Dismisses one pending candidate; no document changes. The actor is the verified user, never the body. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!query.success) return invalidRequest(issues(query.error));

  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  const refused = await refuseBody(request);
  if (refused) return refused;

  const result = await dismissSupersession({
    candidateId: parsed.data.id,
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
  });
  if (!result.ok) return supersessionFailure(result.reason);
  console.log('[RAG Admin] supersession dismissed', { candidateId: result.candidateId });
  return jsonNoStore({ success: true, id: result.candidateId, outcome: 'dismissed' });
}
