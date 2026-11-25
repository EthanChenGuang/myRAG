import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { addExemption, exemptionChoices, listExemptions, removeExemption } from '@/lib/rag';
import { IdSchema, OrganizationIdSchema, admission, approvalFailure, invalidRequest, issues, jsonNoStore, projectExemption } from '../_lib';

export const runtime = 'nodejs';

const ListQuerySchema = z.object({
  organizationId: OrganizationIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const WorkspaceQuerySchema = z.object({ organizationId: OrganizationIdSchema });
const DeleteQuerySchema = z.object({ organizationId: OrganizationIdSchema, id: IdSchema });
/** The creator is the verified user; kind and ref are the only input. The ref must name a connection or a user of the workspace. */
const AddBodySchema = z.object({ kind: z.enum(['connector', 'uploader']), ref: z.string().trim().min(1).max(512) }).strict();

const EXEMPTION_NOT_FOUND = 'Exemption not found';

/** Exemptions of the workspace and the choices for a new one (its connections and users). */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = ListQuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  });
  const admitted = admission(await checkAdminOrOrgAdmin(request, parsed.success ? parsed.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const scope = { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal };
  const list = await listExemptions({ ...scope, limit: parsed.data.limit, offset: parsed.data.offset });
  if (!list.ok) return approvalFailure(list.reason, undefined, EXEMPTION_NOT_FOUND);
  const choices = await exemptionChoices(scope);
  if (!choices.ok) return approvalFailure(choices.reason, undefined, EXEMPTION_NOT_FOUND);
  console.log('[RAG Admin] upload exemptions listed', { count: list.items.length, total: list.total });
  return jsonNoStore({
    success: true,
    total: list.total,
    limit: list.limit,
    offset: list.offset,
    items: list.items.map(projectExemption),
    choices: { connector: choices.connector, uploader: choices.uploader },
  });
}

export async function POST(request: Request): Promise<Response> {
  const query = WorkspaceQuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!query.success) return invalidRequest(issues(query.error));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest([{ path: '', message: 'Body is not valid JSON' }]);
  }
  const parsed = AddBodySchema.safeParse(body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await addExemption({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    kind: parsed.data.kind,
    ref: parsed.data.ref,
    signal: request.signal,
  });
  if (!result.ok) return approvalFailure(result.reason, undefined, EXEMPTION_NOT_FOUND);
  console.log('[RAG Admin] upload exemption saved', { id: result.item.id, kind: result.item.kind, outcome: result.outcome });
  return jsonNoStore({ success: true, outcome: result.outcome, item: projectExemption(result.item) }, result.outcome === 'added' ? 201 : 200);
}

export async function DELETE(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = DeleteQuerySchema.safeParse({ organizationId: params.get('organizationId'), id: params.get('id') ?? undefined });
  const workspace = WorkspaceQuerySchema.safeParse({ organizationId: params.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, workspace.success ? workspace.data.organizationId : null));
  if (!admitted.ok) return admitted.response;
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await removeExemption({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    exemptionId: parsed.data.id,
    signal: request.signal,
  });
  if (!result.ok) return approvalFailure(result.reason, undefined, EXEMPTION_NOT_FOUND);
  console.log('[RAG Admin] upload exemption removed', { id: result.id });
  return jsonNoStore({ success: true, id: result.id });
}
