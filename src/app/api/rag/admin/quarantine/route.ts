import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listNotChecked, listQuarantine, type QuarantineItem } from '@/lib/rag';
import { invalidRequest, jsonNoStore, quarantineFailure } from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z
  .object({
    view: z.enum(['quarantined', 'not_checked']).default('quarantined'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

type Reason = QuarantineItem['reasons'][number];

/** Named fields only (UI-SPEC 11.4, 11.5): no checker version, no bounding box. Spans and targets are document-written text, returned as JSON strings. */
function reasonOf(reason: Reason) {
  const base = { kind: reason.kind, detail: reason.detail };
  switch (reason.kind) {
    case 'hidden_text':
      return { ...base, spans: reason.spans.map((span) => ({ page: span.page, text: span.text, reason: span.reason })), unlocated: reason.unlocated };
    case 'untrusted_link':
      return { ...base, targets: [...reason.targets], unlocated: reason.unlocated };
    default:
      return { ...base, unlocated: reason.unlocated };
  }
}

/**
 * Quarantined versions of the tenants the verified admin administers, newest first, with their reasons; `view=not_checked` lists the
 * current documents no hidden-text checker covered (D-34). Evidence, file names and uploader names in the answer are never logged.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    view: url.searchParams.get('view') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }
  const { view, limit, offset } = parsed.data;

  if (view === 'not_checked') {
    const result = await listNotChecked({ actorUserId: admin.userId, limit, offset, signal: request.signal });
    if (!result.ok) return quarantineFailure(result.reason);
    console.log('[RAG Admin] not-checked documents listed', { count: result.items.length });
    return jsonNoStore({
      success: true,
      view,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      items: result.items.map((item) => ({
        id: item.documentId,
        lineage_id: item.lineageId,
        tenant_key: item.tenantKey,
        filename: item.filename,
        doc_type: item.docType,
        source: item.source,
        uploaded_at: item.uploadedAt,
      })),
    });
  }

  const result = await listQuarantine({ actorUserId: admin.userId, limit, offset, signal: request.signal });
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
      reasons: item.reasons.map(reasonOf),
      unlocated: item.unlocated,
      uploader: item.uploader ? { id: item.uploader.id, display: item.uploader.display } : null,
      pending_approval: item.pendingApproval,
    })),
  });
}
