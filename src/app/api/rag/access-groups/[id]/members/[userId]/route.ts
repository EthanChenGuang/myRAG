import { z } from 'zod/v3';
import { removeMember } from '@/lib/rag';
import { requireAccessAdmin } from '../../../_auth';
import { TAG, fail, failureOf, invalid, ok, requestedWorkspace, serviceDeps } from '../../../_responses';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string; userId: string }> };

const ParamsSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

/** Removes a member from the group; a user who is not a member, or an unknown group, answers 404. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const workspace = requestedWorkspace(request);
  const query = QuerySchema.safeParse({ organizationId: workspace.ok ? workspace.organizationId : null });
  const admin = await requireAccessAdmin(request, query.success ? (query.data.organizationId ?? null) : null, request.signal);
  if (!admin.ok) return admin.response;
  if (!query.success) return invalid(query.error);
  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const removed = await removeMember(admin.scope, { groupId: params.data.id, userId: params.data.userId, actorId: admin.actorId }, serviceDeps(request));
    if (!removed) return fail(404, 'not_found');
    console.log(`${TAG} member removed`, { action: 'access_member_remove', groupId: params.data.id, via: admin.via });
    return ok({ removed: true });
  } catch (error) {
    return failureOf(error);
  }
}
