import { z } from 'zod/v3';
import { deleteConnectorMap, setConnectorMap } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { TAG, connectorVisibilityApplies, fail, failureOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const ParamsSchema = z.object({ id: z.string().uuid() });
const ChangeSchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    groupId: z.string().uuid(),
  })
  .strict();

/** Points a mapping at another access group. An unknown id and an id of another workspace both answer 404. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  const parsed = ChangeSchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const mapping = await setConnectorMap(admin.scope, { id: params.data.id, groupId: parsed.data.groupId }, admin.actorId, serviceDeps(request));
    console.log(`${TAG} connector mapping saved`, { action: 'connector_map_change', mappingId: mapping.id, outcome: mapping.outcome, via: admin.via });
    return ok({ mapping, appliesAt: 'next_sync', visibilityApplies: connectorVisibilityApplies() });
  } catch (error) {
    return failureOf(error);
  }
}

/** Removes a mapping; its documents fall back at the next sync of each connection. */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const workspace = requestedWorkspace(request);
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const removed = await deleteConnectorMap(admin.scope, { id: params.data.id }, admin.actorId, serviceDeps(request));
    if (!removed) return fail(404, 'not_found');
    console.log(`${TAG} connector mapping removed`, { action: 'connector_map_delete', mappingId: params.data.id, via: admin.via });
    return ok({ removed: true, appliesAt: 'next_sync' });
  } catch (error) {
    return failureOf(error);
  }
}
