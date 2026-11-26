import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { previewTerminology } from '@/lib/rag';
import { PreviewBodySchema, failure, invalid, layerKeyFor, ok, readJson, workspaceScope } from '../_lib';

export const runtime = 'nodejs';

/**
 * D-22, D-32: what a query expands to for the admin's workspace, with optional draft entries applied in memory only. The cache is
 * bypassed and nothing is written; the query is never logged (AGENTS.md §12).
 */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = PreviewBodySchema.safeParse(json.body);
  if (!parsed.success) return invalid(parsed.error);
  const body = parsed.data;

  const layer = await layerKeyFor(admin.userId, body.layer, body.organization_id, request.signal);
  if (!layer.ok) return layer.response;
  const workspace = await workspaceScope(admin.userId, body.organization_id, request.signal);
  if (!workspace.ok) return workspace.response;

  const result = await previewTerminology({
    actorUserId: admin.userId,
    scope: workspace.scope,
    layerKey: layer.layerKey,
    query: body.query,
    drafts: body.draft_entries ?? [],
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  return ok({ ...result.preview });
}
