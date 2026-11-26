import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listTerminologyCandidates, scopeKey } from '@/lib/rag';
import { CandidateListQuerySchema, failure, invalid, ok, queryOf, workspaceScope } from '../_lib';

export const runtime = 'nodejs';

/** D-26: one page of the pending candidates of the admin's workspace (s:default in single-tenant mode), by support. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = CandidateListQuerySchema.safeParse(queryOf(request));
  if (!parsed.success) return invalid(parsed.error);
  const query = parsed.data;

  const workspace = await workspaceScope(admin.userId, query.organization_id, request.signal);
  if (!workspace.ok) return workspace.response;

  const result = await listTerminologyCandidates({
    actorUserId: admin.userId,
    tenantKey: scopeKey(workspace.scope),
    limit: query.limit ?? undefined,
    offset: query.offset ?? undefined,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  return ok({ items: result.items, limit: result.limit, offset: result.offset, next_offset: result.nextOffset });
}
