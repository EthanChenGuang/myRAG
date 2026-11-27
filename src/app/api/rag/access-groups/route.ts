import { z } from 'zod/v3';
import {
  accessStatus,
  createGroup,
  listConnectorMap,
  listGroups,
  type AccessGroupListItem,
  type AccessServiceDeps,
  type TenantScope,
} from '@/lib/rag';
import { requireAccessAdmin } from './_auth';
import { TAG, accessGroupsEnabled, fail, failureOf, groupOf, guardWorkspace, invalid, ok, readJson, requestedWorkspace, serviceDeps } from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  organizationId: z.string().max(64).nullish(),
  cursor: z.string().max(400).nullish(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const BodySchema = z
  .object({
    organizationId: z.string().max(64).nullish(),
    key: z.string().max(200),
    name: z.string().trim().min(1).max(200),
  })
  .strict();

/** Pages scanned for unmapped source groups (they sort first, 50 per page). */
const UNMAPPED_SCAN_PAGES = 20;
const CONNECTOR_MAP_PAGE = 50;

function listItemOf(group: AccessGroupListItem) {
  return { ...groupOf(group), memberCount: group.memberCount, documentCount: group.documentCount };
}

/** Source groups seen at a sync with no mapping yet. Unmapped rows sort first, so the scan stops at the first mapped row. */
async function unmappedSourceGroups(scope: TenantScope, deps: AccessServiceDeps): Promise<number> {
  let unmapped = 0;
  for (let page = 0; page < UNMAPPED_SCAN_PAGES; page += 1) {
    const result = await listConnectorMap(scope, { offset: page * CONNECTOR_MAP_PAGE }, deps);
    for (const row of result.rows) {
      if (row.id !== null) return unmapped;
      unmapped += 1;
    }
    if (result.rows.length < CONNECTOR_MAP_PAGE || (page + 1) * CONNECTOR_MAP_PAGE >= result.total) return unmapped;
  }
  return unmapped;
}

/** The inputs of the Enforcement alert: switch, database flag and readiness. The embed group is read by the status route only. */
async function enforcementOf(deps: AccessServiceDeps) {
  const status = await accessStatus({ ...deps, embedScope: async () => null });
  return { runningSwitch: status.runningSwitch, databaseFlag: status.databaseFlag, status: status.status, ready: status.ready, reasons: status.reasons };
}

/** The workspace's groups with member and document counts, plus the alert inputs every Config UI sub-view renders (UI-SPEC 8.1). */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    organizationId: params.get('organizationId'),
    cursor: params.get('cursor'),
    limit: params.get('limit') ?? undefined,
  });
  const admin = await requireAccessAdmin(request, parsed.success ? (parsed.data.organizationId ?? null) : null, request.signal);
  if (!admin.ok) return admin.response;
  if (!parsed.success) return invalid(parsed.error);

  const deps = serviceDeps(request);
  try {
    const enforcement = await enforcementOf(deps);
    if (admin.scope.kind === 'personal') {
      return ok({ personal: true, enabled: accessGroupsEnabled(), groups: [], nextCursor: null, alerts: { unmappedSourceGroups: 0, enforcement } });
    }
    const page = await listGroups(admin.scope, { cursor: parsed.data.cursor ?? null, ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) }, deps);
    const unmapped = await unmappedSourceGroups(admin.scope, deps);
    return ok({
      personal: false,
      enabled: accessGroupsEnabled(),
      groups: page.groups.map(listItemOf),
      nextCursor: page.nextCursor,
      alerts: { unmappedSourceGroups: unmapped, enforcement },
    });
  } catch (error) {
    return failureOf(error);
  }
}

/** Creates a group. The creator is the admin the guard verified; the key is immutable afterwards. */
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
    const group = await createGroup(admin.scope, { key: parsed.data.key, name: parsed.data.name, actorId: admin.actorId }, serviceDeps(request));
    console.log(`${TAG} group created`, { action: 'access_group_create', groupId: group.id, via: admin.via });
    return ok({ group: groupOf(group) }, 201);
  } catch (error) {
    return failureOf(error);
  }
}
