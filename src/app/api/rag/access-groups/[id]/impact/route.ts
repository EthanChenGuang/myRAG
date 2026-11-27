import { z } from 'zod/v3';
import { groupImpact } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { fail, failureOf, invalid, ok, requestedWorkspace, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

/** What deleting the group changes: documents restricted to it alone, documents that keep another group, members, connector mappings. */
export async function GET(request: Request, context: Context): Promise<Response> {
  const workspace = requestedWorkspace(request);
  const query = QuerySchema.safeParse({ organizationId: workspace.ok ? workspace.organizationId : null });
  const admin = await requireAccessAdmin(request, query.success ? (query.data.organizationId ?? null) : null, request.signal);
  if (!admin.ok) return admin.response;
  if (!query.success) return invalid(query.error);
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const impact = await groupImpact(admin.scope, { groupId: params.data.id }, serviceDeps(request));
    return ok({ impact: { onlyCount: impact.onlyCount, sharedCount: impact.sharedCount, memberCount: impact.memberCount, mappingCount: impact.mappingCount } });
  } catch (error) {
    return failureOf(error);
  }
}
