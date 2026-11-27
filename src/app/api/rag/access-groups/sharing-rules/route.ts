import { z } from 'zod/v3';
import { CONNECTOR_PROVIDERS, listSharingRules, setSharingRule } from '@/lib/rag';
import { requireAccessAdmin } from '../_auth';
import { TAG, connectorVisibilityApplies, fail, failureOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({ organizationId: z.string().max(64).nullish() });

const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    provider: z.enum(CONNECTOR_PROVIDERS),
    kind: z.enum(['domain', 'anyone', 'public']),
    domain: z.string().max(1000).nullish(),
  })
  .strict();

/** D-20, UI-SPEC 6.5: rules and the domain, link and published sharing a sync has seen, with document counts. */
export async function GET(request: Request): Promise<Response> {
  const parsed = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admin = await requireAccessAdmin(request, parsed.success ? (parsed.data.organizationId ?? null) : null, request.signal);
  if (!admin.ok) return admin.response;
  if (!parsed.success) return invalid(parsed.error);

  const visibilityApplies = connectorVisibilityApplies();
  if (admin.scope.kind === 'personal') return ok({ personal: true, visibilityApplies, rules: [] });
  try {
    const rules = await listSharingRules(admin.scope, serviceDeps(request));
    return ok({ personal: false, visibilityApplies, rules });
  } catch (error) {
    return failureOf(error);
  }
}

/** Creates a sharing rule, always off. A domain rule needs a host name with a dot and no scheme, path, port, wildcard or space. */
export async function POST(request: Request): Promise<Response> {
  const read = await readJson(request);
  const workspace = read.ok ? requestedWorkspace(request, read.body) : null;
  const admin = await requireAccessAdmin(request, guardWorkspace(workspace), request.signal);
  if (!admin.ok) return admin.response;
  if (!read.ok) return read.response;
  if (workspace && !workspace.ok) return workspace.response;

  const parsed = BodySchema.safeParse(read.body);
  if (!parsed.success) return invalid(parsed.error);
  if (admin.scope.kind === 'personal') return fail(400, 'personal_tenant');

  try {
    const { provider, kind, domain } = parsed.data;
    const rule = await setSharingRule(admin.scope, { provider, kind, domain: domain ?? null }, admin.actorId, serviceDeps(request));
    console.log(`${TAG} sharing rule saved`, { action: 'sharing_rule_create', ruleId: rule.id, outcome: rule.outcome, via: admin.via });
    return ok({ rule, appliesAt: 'next_sync' }, 201);
  } catch (error) {
    return failureOf(error);
  }
}
