import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { listExemptions, listPendingUploads } from '@/lib/rag';
import { OrganizationIdSchema, admission, approvalFailure, invalidRequest, issues, jsonNoStore, projectExemption, projectPending } from './_lib';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  organizationId: OrganizationIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Pending uploads of the workspace, the approval mode and the workspace's exemptions (UI-SPEC 8.1). */
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

  const scope = { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal };
  const pending = await listPendingUploads({ ...scope, limit: parsed.data.limit, offset: parsed.data.offset });
  if (!pending.ok) return approvalFailure(pending.reason);
  const exemptions = await listExemptions({ ...scope, limit: 100, offset: 0 });
  if (!exemptions.ok) return approvalFailure(exemptions.reason);
  console.log('[RAG Admin] pending uploads listed', { count: pending.items.length, total: pending.total, exemptions: exemptions.total });
  return jsonNoStore({
    success: true,
    mode: pending.mode,
    total: pending.total,
    limit: pending.limit,
    offset: pending.offset,
    items: pending.items.map(projectPending),
    exemptions: exemptions.items.map(projectExemption),
    exemptions_total: exemptions.total,
  });
}
