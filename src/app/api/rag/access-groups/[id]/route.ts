import { z } from 'zod/v3';
import { deleteGroup, renameGroup } from '@/lib/rag';
import { requireAccessAdmin } from '../_auth';
import { TAG, fail, failureOf, groupOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const ParamsSchema = z.object({ id: z.string().uuid() });
const RenameSchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
const DeleteSchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    expectedCount: z.number().int().min(0),
  })
  .strict();

/** Renames a group (the key never changes). An unknown id and an id of another tenant both answer 404. */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  const parsed = RenameSchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const group = await renameGroup(admin.scope, { groupId: params.data.id, name: parsed.data.name, actorId: admin.actorId }, serviceDeps(request));
    console.log(`${TAG} group renamed`, { action: 'access_group_rename', groupId: group.id, via: admin.via });
    return ok({ group: groupOf(group) });
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * Deletes a group once the caller confirms the number of documents restricted to it alone (`expectedCount`, from GET impact). A stale
 * count answers 409 count_required with the current count; documents left with no group fall back to their owner.
 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  const parsed = DeleteSchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const result = await deleteGroup(
      admin.scope,
      { groupId: params.data.id, expectedOnlyCount: parsed.data.expectedCount, actorId: admin.actorId },
      serviceDeps(request),
    );
    console.log(`${TAG} group deleted`, { action: 'access_group_delete', groupId: params.data.id, fellBack: result.fellBack, via: admin.via });
    return ok({ fellBack: result.fellBack, relabelled: result.relabelled });
  } catch (error) {
    return failureOf(error);
  }
}
