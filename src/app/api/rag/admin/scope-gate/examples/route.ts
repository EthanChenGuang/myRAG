import { z } from 'zod/v3';
import { addScopeExample } from '@/lib/rag';
import { OrganizationIdSchema, fail, invalid, jsonNoStore, organizationIdParam, requireAdminOrDenyWithActor, resolveWorkspace, unavailable } from '../_lib';

export const runtime = 'nodejs';

/** The body carries the text only; length and emptiness are the service's codes (text_empty, text_too_long), not a zod detail. */
const BodySchema = z.object({ text: z.string().max(10_000) }).strict();

const STATUS: Record<string, number> = { text_empty: 400, text_too_long: 400, example_exists: 409, limit: 409, embedding_unavailable: 503 };

/**
 * D-25: adds an out-of-scope example to the verified admin's workspace, embedded at save time with the active profile. created_by is
 * the actor the guard verified; a body field naming another actor is rejected by the strict schema. The text is never logged.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminOrDenyWithActor(request);
  if (!gate.ok) return gate.response;

  const org = OrganizationIdSchema.safeParse(organizationIdParam(request));
  if (!org.success) return invalid(org.error);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, 'Invalid request data', [{ path: '', message: 'Body must be JSON' }]);
  }
  const body = BodySchema.safeParse(raw);
  if (!body.success) return invalid(body.error);

  const workspace = await resolveWorkspace(gate.userId, org.data, request.signal);
  if (!workspace.ok) return workspace.response;

  try {
    const result = await addScopeExample(workspace.scope, { text: body.data.text, actorId: gate.userId });
    if (!result.ok) {
      const status = STATUS[result.code];
      console.log('[RAG Admin] scope example not added', { action: 'add_scope_example', code: result.code });
      return status ? fail(status, result.code) : unavailable();
    }
    console.log('[RAG Admin] scope example added', { action: 'add_scope_example', exampleId: result.example.id });
    return jsonNoStore({ success: true, example: { id: result.example.id, createdAt: result.example.createdAt, createdBy: gate.userId } }, 201);
  } catch (error) {
    console.error('[RAG Admin] scope example add failed', { reason: error instanceof Error ? error.name : 'unexpected' });
    return unavailable();
  }
}
