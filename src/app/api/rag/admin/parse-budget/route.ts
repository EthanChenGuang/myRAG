import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { ParseAdminError, readBudgetView, resolveAdminWorkspaceScope } from '@/lib/rag';
import { fail, invalid, jsonNoStore } from '../ingest-jobs/_lib';

export const runtime = 'nodejs';

const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

/**
 * This UTC month's reserved, used and L3 pages of one workspace of the verified admin (the personal or default one, or an organization
 * named by `organizationId` after the membership check), with the configured monthly budget and the per-document cap. Another tenant's
 * usage is never read.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveAdminWorkspaceScope({
    adminUserId: admin.userId,
    requestedOrganizationId: parsed.data.organizationId ?? null,
    signal: request.signal,
  });
  if (!workspace.ok) return fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable');

  try {
    const view = await readBudgetView(workspace.scope, request.signal);
    return jsonNoStore({ success: true, ...view });
  } catch (error) {
    console.error('[RAG Admin] parse budget read failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof ParseAdminError ? { rpc: error.rpc, code: error.code } : {}),
    });
    return fail(503, 'Parse budget is unavailable');
  }
}
