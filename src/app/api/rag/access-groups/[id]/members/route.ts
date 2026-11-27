import { z } from 'zod/v3';
import { addMember, listMembers } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { TAG, fail, failureOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });
const AddSchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    userId: z.string().uuid(),
  })
  .strict();

/** The group's members (D-29: admins only; members read their own groups through GET /mine). */
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
    const members = await listMembers(admin.scope, { groupId: params.data.id }, serviceDeps(request));
    return ok({ members: members.map((m) => ({ userId: m.userId, displayName: m.displayName, email: m.email, addedAt: m.addedAt, source: m.source })) });
  } catch (error) {
    return failureOf(error);
  }
}

/** Adds a workspace member to the group. 409 member_exists when already in it; 400 not_a_workspace_member for anyone else. */
export async function POST(request: Request, context: Context): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  const parsed = AddSchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const added = await addMember(admin.scope, { groupId: params.data.id, userId: parsed.data.userId, actorId: admin.actorId }, serviceDeps(request));
    console.log(`${TAG} member added`, { action: 'access_member_add', groupId: added.groupId, via: admin.via });
    return ok({ member: { groupId: added.groupId, userId: added.userId, addedAt: added.addedAt } }, 201);
  } catch (error) {
    return failureOf(error);
  }
}
