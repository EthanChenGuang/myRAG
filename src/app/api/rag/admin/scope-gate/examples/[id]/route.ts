import { z } from 'zod/v3';
import { deleteScopeExample } from '@/lib/rag';
import { ExampleIdSchema, OrganizationIdSchema, fail, invalid, jsonNoStore, organizationIdParam, requireAdminOrDenyWithActor, resolveWorkspace, unavailable } from '../../_lib';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ParamsSchema = z.object({ id: ExampleIdSchema, organizationId: OrganizationIdSchema });

/** D-25: deletes one example of the verified admin's workspace by id. Another workspace's example answers exactly like an unknown id. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const gate = await requireAdminOrDenyWithActor(request);
  if (!gate.ok) return gate.response;

  const { id } = await context.params;
  const parsed = ParamsSchema.safeParse({ id, organizationId: organizationIdParam(request) });
  if (!parsed.success) return invalid(parsed.error);

  const workspace = await resolveWorkspace(gate.userId, parsed.data.organizationId, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const result = await deleteScopeExample(workspace.scope, parsed.data.id);
    if (!result.ok) {
      if (result.code === 'not_found' || result.code === 'invalid_id') return fail(404, 'Example not found');
      console.error('[RAG Admin] scope example delete failed', { code: result.code });
      return unavailable();
    }
    console.log('[RAG Admin] scope example deleted', { action: 'delete_scope_example', exampleId: parsed.data.id });
    return jsonNoStore({ success: true });
  } catch (error) {
    console.error('[RAG Admin] scope example delete failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return unavailable();
  }
}
