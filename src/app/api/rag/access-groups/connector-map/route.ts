import { z } from 'zod/v3';
import { CONNECTOR_PROVIDERS, listConnectorMap, setConnectorMap } from '@/lib/rag';
import { requireAccessAdmin } from '../_auth';
import { TAG, connectorVisibilityApplies, fail, failureOf, guardWorkspace, invalid, mappingRowOf, ok, readJson, requestedWorkspace, serviceDeps } from '../_responses';

export const runtime = 'nodejs';

const PAGE_SIZE = 50;

const QuerySchema = z.object({
  organizationId: z.string().max(64).nullish(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    provider: z.enum(CONNECTOR_PROVIDERS),
    kind: z.enum(['group', 'team', 'workspace']),
    externalPrincipalId: z.string().trim().min(1).max(512),
    groupId: z.string().uuid(),
  })
  .strict();

/**
 * D-20, UI-SPEC 6.5 and 8.1: mapped rows and source groups, teams and workspaces a sync has seen, unmapped first, 50 per page, with the
 * number of documents that fell back. `visibilityApplies` is false in multi-tenant mode (A-10): mappings are saved but connector documents
 * stay in their owner's personal workspace.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({ organizationId: params.get('organizationId'), offset: params.get('offset') ?? undefined });
  const admin = await requireAccessAdmin(request, parsed.success ? (parsed.data.organizationId ?? null) : null, request.signal);
  if (!admin.ok) return admin.response;
  if (!parsed.success) return invalid(parsed.error);

  const visibilityApplies = connectorVisibilityApplies();
  if (admin.scope.kind === 'personal') return ok({ personal: true, visibilityApplies, rows: [], total: 0, nextOffset: null });
  const offset = parsed.data.offset ?? 0;
  try {
    const page = await listConnectorMap(admin.scope, { offset }, serviceDeps(request));
    const next = offset + PAGE_SIZE;
    return ok({ personal: false, visibilityApplies, rows: page.rows.map(mappingRowOf), total: page.total, nextOffset: next < page.total ? next : null });
  } catch (error) {
    return failureOf(error);
  }
}

/** Maps a source group to an access group of this workspace. Takes effect at the next sync of each connection; starts no sync. */
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
    const { provider, kind, externalPrincipalId, groupId } = parsed.data;
    const mapping = await setConnectorMap(admin.scope, { provider, kind, externalPrincipalId, groupId }, admin.actorId, serviceDeps(request));
    console.log(`${TAG} connector mapping saved`, { action: 'connector_map_create', mappingId: mapping.id, outcome: mapping.outcome, via: admin.via });
    return ok({ mapping, appliesAt: 'next_sync', visibilityApplies: connectorVisibilityApplies() }, 201);
  } catch (error) {
    return failureOf(error);
  }
}
