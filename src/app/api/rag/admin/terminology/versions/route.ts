import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { getTerminologyVersions } from '@/lib/rag';
import { VersionsQuerySchema, enabledLanguagesBody, failure, invalid, ok, queryOf, workspaceKey } from '../_lib';

export const runtime = 'nodejs';

/** The shared layer's version and hash and, in multi-tenant mode, the admin workspace's (D-05). */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = VersionsQuerySchema.safeParse(queryOf(request));
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await workspaceKey(admin.userId, parsed.data.organization_id, request.signal);
  if (!workspace.ok) return workspace.response;

  const result = await getTerminologyVersions({ actorUserId: admin.userId, workspaceLayerKey: workspace.key, signal: request.signal });
  if (!result.ok) return failure(result);
  const view = (layer: { version: number; entries_sha256: string | null } | null) =>
    layer === null ? null : { version: layer.version, entries_sha256: layer.entries_sha256 };
  return ok({ shared: view(result.shared), workspace: view(result.workspace), ...enabledLanguagesBody() });
}
