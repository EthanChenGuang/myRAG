import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listQuarantine } from '@/lib/rag';
import { invalidRequest, jsonNoStore, quarantineFailure } from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Quarantined versions of the tenants the verified admin administers, newest first. The snippets in the answer are never logged. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const result = await listQuarantine({ actorUserId: admin.userId, ...parsed.data, signal: request.signal });
  if (!result.ok) return quarantineFailure(result.reason);
  console.log('[RAG Admin] quarantine listed', { count: result.items.length });
  return jsonNoStore({
    success: true,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
    items: result.items.map((item) => ({
      id: item.documentId,
      lineage_id: item.lineageId,
      tenant_key: item.tenantKey,
      filename: item.filename,
      source: item.source,
      version: item.version,
      rule_ids: item.ruleIds,
      snippets: item.snippets,
      quarantined_at: item.quarantinedAt,
      detected_by: item.detectedBy,
    })),
  });
}
