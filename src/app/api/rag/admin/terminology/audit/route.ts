import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listTerminologyAudit } from '@/lib/rag';
import { AuditQuerySchema, failure, invalid, layerKeyFor, ok, queryOf } from '../_lib';

export const runtime = 'nodejs';

/** One page of a layer's audit, newest first (D-06). Actors are ids only. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = AuditQuerySchema.safeParse(queryOf(request));
  if (!parsed.success) return invalid(parsed.error);

  const layer = await layerKeyFor(admin.userId, parsed.data.layer, parsed.data.organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await listTerminologyAudit({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    limit: parsed.data.limit ?? undefined,
    offset: parsed.data.offset ?? undefined,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  return ok({ layer: parsed.data.layer, items: result.items, total: result.total, limit: result.limit, offset: result.offset });
}
