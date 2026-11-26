import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { currentIngestConfig, listSupersession } from '@/lib/rag';
import { OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, projectEntry, supersessionFailure } from './_lib';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  organizationId: OrganizationIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/**
 * Pending supersession candidates (stale ones flagged) and confirmed links of one workspace (UI-SPEC 6.8, 8.1). Works with
 * RAG_SUPERSESSION_DETECT off too, so candidates raised earlier can still be decided; `detect` reports the switch.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  });
  const admitted = admission(await checkAdminOrOrgAdmin(request, parsed.success ? parsed.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await listSupersession({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    signal: request.signal,
  });
  if (!result.ok) return supersessionFailure(result.reason);
  let detect: 'on' | 'off' = 'off';
  try {
    detect = currentIngestConfig().supersessionDetect;
  } catch {
    detect = 'off';
  }
  console.log('[RAG Admin] supersession listed', { count: result.items.length, total: result.total });
  return jsonNoStore({
    success: true,
    detect,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    items: result.items.map(projectEntry),
  });
}
