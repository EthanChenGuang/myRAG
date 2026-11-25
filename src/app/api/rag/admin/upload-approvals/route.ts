import { z } from 'zod/v3';
import { checkAdmin } from '@/lib/admin-route-auth';
import { listExemptions, listPendingUploads } from '@/lib/rag';
import type { PendingUpload, UploadExemption } from '@/lib/rag';
import { OrganizationIdSchema, admit, approvalFailure, invalidRequest, issues, jsonNoStore } from './_lib';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  organizationId: OrganizationIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export function projectPending(item: PendingUpload) {
  return {
    id: item.documentId,
    lineage_id: item.lineageId,
    file_name: item.filename,
    uploader: item.uploader,
    source: item.source,
    doc_type: item.docType,
    version: item.version,
    uploaded_at: item.uploadedAt,
    new_version: item.newVersion,
  };
}

export function projectExemption(item: UploadExemption) {
  return { id: item.id, kind: item.kind, ref: item.ref, display: item.display, added_by: item.addedBy, added_at: item.addedAt };
}

/** Pending uploads of the workspace, the approval mode and the workspace's exemptions (UI-SPEC 8.1). */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  });
  const admission = await admit(await checkAdmin(request), parsed.success ? parsed.data.organizationId : null, request.signal);
  if (!admission.ok) return admission.response;
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const scope = { actorUserId: admission.actorUserId, tenantKey: admission.tenantKey, signal: request.signal };
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
