import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listSourceSyncConnections } from '@/lib/nango/source-sync-admin';
import { invalidRequest, issuesOf, jsonNoStore, sourceSyncFailure } from '../_responses';

export const runtime = 'nodejs';

const QuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

/**
 * Connections of the tenants the verified admin administers with their reconcile state, deletion mode and open paused run
 * (D-10, D-39, D-41, UI-SPEC 8.1). Owner labels and file names in the answer are never logged.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  const parsed = QuerySchema.safeParse(query);
  if (!parsed.success) return invalidRequest(issuesOf(parsed.error));

  const result = await listSourceSyncConnections({
    actorUserId: admin.userId,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    signal: request.signal,
  });
  if (!result.ok) return sourceSyncFailure(result.reason);
  const { list } = result;
  console.log('[RAG Admin] source sync connections listed', {
    count: list.items.length,
    paused: list.items.filter((item) => item.paused_run !== null).length,
  });
  return jsonNoStore({ success: true, ...list });
}
