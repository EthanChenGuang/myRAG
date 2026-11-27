import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listPurgeRecords, type PurgeRecord } from '@/lib/rag';
import { invalidRequest, jsonNoStore, purgeFailure } from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

/** Named fields only (UI-SPEC 8.1, 11): no file name, title, path or hash. */
function itemOf(record: PurgeRecord) {
  return {
    id: record.id,
    started_at: record.startedAt,
    actor_kind: record.actorKind,
    actor_id: record.actorId,
    provider: record.provider,
    workspace_key: record.workspaceKey,
    reason_code: record.reasonCode,
    reason_note: record.reasonNote,
    lineage_id: record.lineageId,
    version_count: record.versionCount,
    result: record.result,
    removed: record.removed,
    left: record.left,
    pending_files: record.pendingFiles,
    checked_at: record.checkedAt,
  };
}

/** Purge records of the tenants the verified admin administers, newest first (D-12, D-16). */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return invalidRequest(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  const result = await listPurgeRecords({ actorUserId: admin.userId, limit: parsed.data.limit, offset: parsed.data.offset, signal: request.signal });
  if (!result.ok) return purgeFailure(result.reason);
  console.log('[RAG Admin] purge records listed', { count: result.records.length });
  return jsonNoStore({ success: true, limit: result.limit, offset: result.offset, has_more: result.hasMore, items: result.records.map(itemOf) });
}
