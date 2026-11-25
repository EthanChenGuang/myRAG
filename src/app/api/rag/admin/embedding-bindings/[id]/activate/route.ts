import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { activateBinding } from '@/lib/rag';
import { adminActor, bindingsUnavailable, invalidRequest, issues, jsonNoStore, readJsonBody, refusalResponse } from '../../_responses';
import { bindingBody } from '../../_binding-body';

export const runtime = 'nodejs';

const ParamsSchema = z.object({ id: z.string().uuid() });
/** The activation takes no input: an actor or any other key is refused, the actor is the verified admin. */
const BodySchema = z.object({}).strict();

/** Flips one binding to active through the 0441 gate, which refuses a binding without passing evidence, an incomplete index or a stale baseline. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalidRequest(issues(params.error));
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = BodySchema.safeParse(read.body);
  if (!body.success) return invalidRequest(issues(body.error));

  const bindingId = params.data.id;
  try {
    const result = await activateBinding(bindingId, adminActor(admin.userId));
    if (!result.ok) return refusalResponse('activate', bindingId, result);
    console.log('[Embedding Binding] admin action', { action: 'activate', bindingId: result.binding.id });
    return jsonNoStore({ success: true, activated: bindingBody(result.binding), previous: result.previous });
  } catch (error) {
    return bindingsUnavailable('activate', bindingId, error);
  }
}
