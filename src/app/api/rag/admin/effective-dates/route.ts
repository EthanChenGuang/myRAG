import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { MAX_EFFECTIVE_DATES_QUERY_LENGTH, listEffectiveDateProposals } from '@/lib/rag';
import { OrganizationIdSchema, admission, datesFailure, invalidRequest, issues, jsonNoStore, projectDates } from './_lib';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  organizationId: OrganizationIdSchema,
  query: z.string().max(MAX_EFFECTIVE_DATES_QUERY_LENGTH).nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Effective-date proposals of the workspace (awaiting confirmation first) or, with `query`, documents found by file name (UI-SPEC 6.8). */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    query: params.get('query'),
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  });
  const admitted = admission(await checkAdminOrOrgAdmin(request, parsed.success ? parsed.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await listEffectiveDateProposals({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    query: parsed.data.query ?? null,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    signal: request.signal,
  });
  if (!result.ok) return datesFailure(result.reason);
  console.log('[RAG Admin] effective dates listed', { count: result.items.length, total: result.total, search: result.query !== null });
  return jsonNoStore({
    success: true,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    query: result.query,
    items: result.items.map(projectDates),
  });
}
