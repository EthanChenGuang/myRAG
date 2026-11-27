import { z } from 'zod/v3';
import { memberCandidates } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { fail, failureOf, invalid, ok, requestedWorkspace, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  organizationId: z.string().max(64).nullish(),
  groupId: z.string().uuid(),
  q: z.string().max(200).default(''),
});

/** Minimum query length; shorter queries answer an empty list without the candidate search (UI-SPEC 6.3). */
const MIN_QUERY = 2;

/** Up to 20 members of the workspace matching `q`, each flagged `already` when in the group. */
export async function GET(request: Request): Promise<Response> {
  const workspace = requestedWorkspace(request);
  const search = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: workspace.ok ? workspace.organizationId : null,
    groupId: search.get('groupId') ?? undefined,
    q: search.get('q') ?? undefined,
  });
  const admin = await requireAccessAdmin(request, parsed.success ? (parsed.data.organizationId ?? null) : (workspace.ok ? workspace.organizationId : null), request.signal);
  if (!admin.ok) return admin.response;
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');
  if (parsed.data.q.trim().length < MIN_QUERY) return ok({ candidates: [] });

  try {
    const candidates = await memberCandidates(admin.scope, { groupId: parsed.data.groupId, query: parsed.data.q }, serviceDeps(request));
    return ok({ candidates: candidates.map((c) => ({ userId: c.userId, displayName: c.displayName, email: c.email, already: c.alreadyMember })) });
  } catch (error) {
    return failureOf(error);
  }
}
