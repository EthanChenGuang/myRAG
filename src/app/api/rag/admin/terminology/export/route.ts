import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { exportTerminology } from '@/lib/rag';
import { ExportQuerySchema, failure, invalid, layerKeyFor, queryOf } from '../_lib';

export const runtime = 'nodejs';

/** D-23: one layer as a formula-safe CSV download with the nine-column header. */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ExportQuerySchema.safeParse(queryOf(request));
  if (!parsed.success) return invalid(parsed.error);
  const query = parsed.data;

  const layer = await layerKeyFor(admin.userId, query.layer, query.organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await exportTerminology({ actorUserId: admin.userId, layerKey: layer.layerKey, signal: request.signal });
  if (!result.ok) return failure(result);
  return new Response(result.csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="terminology-${query.layer}-v${result.layerVersion}.csv"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
