import { z } from 'zod/v3';
import { setSharingRule } from '@/lib/rag';
import { requireAccessAdmin } from '../../_auth';
import { TAG, fail, failureOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from '../../_responses';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const ParamsSchema = z.object({ id: z.string().uuid() });
const ToggleSchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    enabled: z.boolean(),
  })
  .strict();

/** Turns a rule on or off. An unknown id and an id of another workspace both answer 404. Takes effect at the next sync. */
export async function PUT(request: Request, context: Context): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const params = ParamsSchema.safeParse(await context.params);
  if (!params.success) return invalid(params.error);
  const parsed = ToggleSchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(404, 'not_found');

  try {
    const rule = await setSharingRule(admin.scope, { id: params.data.id, enabled: parsed.data.enabled }, admin.actorId, serviceDeps(request));
    console.log(`${TAG} sharing rule saved`, { action: 'sharing_rule_toggle', ruleId: rule.id, enabled: rule.enabled, via: admin.via });
    return ok({ rule, appliesAt: 'next_sync' });
  } catch (error) {
    return failureOf(error);
  }
}
