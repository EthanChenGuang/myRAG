import { scopeGateStatus, startScopeRebuild } from '@/lib/rag';
import { OrganizationIdSchema, fail, invalid, jsonNoStore, organizationIdParam, requireAdminOrDenyWithActor, resolveWorkspace, unavailable } from '../_lib';

export const runtime = 'nodejs';

/**
 * D-25: rebuilds the verified admin's workspace scope data for the active profile. 200 with the counts when it finished within the
 * wait, 202 while it runs, 409 rebuild_running when one is already in progress and 409 unsupported_binding while a doc-type-scoped
 * embedding binding keeps the gate unsure (D-38). The body is never read.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminOrDenyWithActor(request);
  if (!gate.ok) return gate.response;

  const org = OrganizationIdSchema.safeParse(organizationIdParam(request));
  if (!org.success) return invalid(org.error);
  const workspace = await resolveWorkspace(gate.userId, org.data, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const status = await scopeGateStatus(workspace.scope);
    if (!status.ok) {
      console.error('[RAG Admin] scope rebuild failed', { code: status.code });
      return unavailable();
    }
    if (status.status.unsupported) return fail(409, 'unsupported_binding');
    if (status.status.rebuildRunning) return fail(409, 'rebuild_running');

    const outcome = await startScopeRebuild(workspace.scope);
    if (outcome.status === 'running') return fail(409, 'rebuild_running');
    if (outcome.status === 'started') {
      console.log('[RAG Admin] scope rebuild started', { action: 'rebuild_scope_data' });
      return jsonNoStore({ success: true, status: 'running' }, 202);
    }
    if (outcome.status === 'failed') {
      console.error('[RAG Admin] scope rebuild failed', { code: outcome.code });
      return unavailable();
    }
    const counts = outcome.result.counts;
    console.log('[RAG Admin] scope rebuild finished', {
      action: 'rebuild_scope_data',
      groups: counts.doc_type.groups + counts.scope_tag.groups + counts.tenant.groups,
    });
    return jsonNoStore({
      success: true,
      status: 'done',
      kinds: (['doc_type', 'scope_tag', 'tenant'] as const).map((kind) => ({ kind, referencePoints: counts[kind].groups, chunksIncluded: counts[kind].chunks })),
    });
  } catch (error) {
    console.error('[RAG Admin] scope rebuild failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return unavailable();
  }
}
