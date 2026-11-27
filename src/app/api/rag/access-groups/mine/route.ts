import { z } from 'zod/v3';
import { myGroups } from '@/lib/rag';
import { memberWorkspaceScope, requireAccessUser } from '../_auth';
import { failureOf, invalid, ok, accessGroupsEnabled, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

/**
 * D-16, D-29, UI-SPEC 6.1: the caller's own groups and the groups they may assign at upload, for any verified session. A non-admin learns
 * nothing about other groups or their members. With the switch off the answer is `enabled: false` only, so the app renders as today.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireAccessUser(request, request.signal);
  if (!user.ok) return user.response;

  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsed.success) return invalid(parsed.error);
  if (!accessGroupsEnabled()) return ok({ enabled: false });

  const workspace = await memberWorkspaceScope(user.userId, parsed.data.organizationId ?? null, request.signal);
  if (!workspace.ok) return workspace.response;
  if (workspace.scope.kind === 'personal') {
    return ok({ enabled: true, personal: true, isAdmin: false, ownGroups: [], assignableGroups: [] });
  }

  try {
    const mine = await myGroups(workspace.scope, { userId: user.userId }, serviceDeps(request));
    return ok({ enabled: true, personal: false, isAdmin: mine.isAdmin, ownGroups: mine.ownGroups, assignableGroups: mine.assignableGroups });
  } catch (error) {
    return failureOf(error);
  }
}
