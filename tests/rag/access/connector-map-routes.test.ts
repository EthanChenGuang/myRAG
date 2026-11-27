import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000033a1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000033a2';
const MEMBER_A = '00000000-0000-4000-8000-0000000033b1';
const ORG_O = '00000000-0000-4000-8000-0000000033c1';
const ORG_P = '00000000-0000-4000-8000-0000000033c2';
const GROUP_A = '00000000-0000-4000-8000-0000000033d1';
const GROUP_B = '00000000-0000-4000-8000-0000000033d2';
const GROUP_P = '00000000-0000-4000-8000-0000000033d3';
const UNKNOWN = '00000000-0000-4000-8000-0000000033ff';
const SOURCE_GROUP = 'group-x@example.org';

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };
type Mapping = { id: string; tenant: string; provider: string; kind: string; pid: string; groupId: string };
type Rule = { id: string; tenant: string; provider: string; kind: string; domain: string | null; enabled: boolean };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  groups: {} as Record<string, string[]>,
  mappings: [] as Mapping[],
  seen: [] as Array<{ tenant: string; provider: string; kind: string; pid: string; documents: number }>,
  rules: [] as Rule[],
  failClosed: {} as Record<string, Array<{ connection_id: string; documents: number }>>,
  nextId: 1,
};

const refuse = (message: string): RpcOutcome => ({ data: null, error: { code: '22023', message } });
const newId = () => `00000000-0000-4000-8000-${String(state.nextId++).padStart(12, '0')}`;

const RPC: Record<string, (_args: Record<string, unknown>) => RpcOutcome> = {
  rag_connector_map_list(args) {
    const tenant = String(args.p_tenant_key);
    const mapped = state.mappings.filter((m) => m.tenant === tenant);
    const rows = [
      ...state.seen
        .filter((s) => s.tenant === tenant && !mapped.some((m) => m.provider === s.provider && m.pid === s.pid))
        .map((s) => ({ id: null, provider: s.provider, kind: s.kind, external_principal_id: s.pid, group_id: null, documents: s.documents })),
      ...mapped.map((m) => ({ id: m.id, provider: m.provider, kind: m.kind, external_principal_id: m.pid, group_id: m.groupId, documents: 0 })),
    ];
    const offset = Number(args.p_offset);
    return { data: rows.slice(offset, offset + 50).map((row) => ({ ...row, total: rows.length })), error: null };
  },
  rag_connector_map_set(args) {
    const tenant = String(args.p_tenant_key);
    const existing = args.p_id ? state.mappings.find((m) => m.id === args.p_id && m.tenant === tenant) : undefined;
    if (args.p_id && !existing) return refuse('mapping_not_found');
    if (!(state.groups[tenant] ?? []).includes(String(args.p_group_id))) return refuse('unknown_group');
    if (existing) {
      const outcome = existing.groupId === args.p_group_id ? 'unchanged' : 'changed';
      existing.groupId = String(args.p_group_id);
      return { data: [{ id: existing.id, group_id: existing.groupId, outcome }], error: null };
    }
    if (state.mappings.some((m) => m.tenant === tenant && m.provider === args.p_provider && m.pid === args.p_external_principal_id)) return refuse('mapping_exists');
    const mapping = { id: newId(), tenant, provider: String(args.p_provider), kind: String(args.p_kind), pid: String(args.p_external_principal_id), groupId: String(args.p_group_id) };
    state.mappings.push(mapping);
    return { data: [{ id: mapping.id, group_id: mapping.groupId, outcome: 'created' }], error: null };
  },
  rag_connector_map_delete(args) {
    const index = state.mappings.findIndex((m) => m.id === args.p_id && m.tenant === args.p_tenant_key);
    if (index < 0) return refuse('mapping_not_found');
    state.mappings.splice(index, 1);
    return { data: true, error: null };
  },
  rag_connector_rules_list(args) {
    return {
      data: state.rules.filter((r) => r.tenant === args.p_tenant_key).map((r) => ({ id: r.id, provider: r.provider, kind: r.kind, domain: r.domain, enabled: r.enabled, documents: 4 })),
      error: null,
    };
  },
  rag_connector_rule_set(args) {
    const tenant = String(args.p_tenant_key);
    if (args.p_id) {
      const rule = state.rules.find((r) => r.id === args.p_id && r.tenant === tenant);
      if (!rule) return refuse('rule_not_found');
      const outcome = rule.enabled === args.p_enabled ? 'unchanged' : args.p_enabled ? 'enabled' : 'disabled';
      rule.enabled = args.p_enabled === true;
      return { data: [{ id: rule.id, enabled: rule.enabled, outcome }], error: null };
    }
    if (state.rules.some((r) => r.tenant === tenant && r.provider === args.p_provider && r.kind === args.p_kind && r.domain === args.p_domain)) return refuse('rule_exists');
    const rule = { id: newId(), tenant, provider: String(args.p_provider), kind: String(args.p_kind), domain: (args.p_domain as string | null) ?? null, enabled: args.p_enabled === true };
    state.rules.push(rule);
    return { data: [{ id: rule.id, enabled: rule.enabled, outcome: 'created' }], error: null };
  },
  rag_connector_fail_closed_counts(args) {
    return { data: state.failClosed[String(args.p_tenant_key)] ?? [], error: null };
  },
};

function query(table: string) {
  const filters: Array<(_row: Row) => boolean> = [];
  let limit = Infinity;
  const run = () => ({ data: (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(0, limit), error: null });
  const builder = {
    select: () => builder,
    abortSignal: () => builder,
    order: () => builder,
    limit(value: number) {
      limit = value;
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: run().data[0] ?? null, error: null });
    },
    then(onFulfilled: (_value: unknown) => unknown, onRejected?: (_reason: unknown) => unknown) {
      return Promise.resolve(run()).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from: (table: string) => query(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const outcome = RPC[fn] ? RPC[fn](args) : { data: [], error: null };
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (_value: RpcOutcome) => unknown, onRejected?: (_reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function load() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = state.mode;
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  const map = await import('@/app/api/rag/access-groups/connector-map/route');
  const mapId = await import('@/app/api/rag/access-groups/connector-map/[id]/route');
  return { map, mapId };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; body?: unknown } = {}) {
  const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body } : {}) });
}

const withOrg = (path: string, org?: string) => `/api/rag/access-groups${path}${org ? `${path.includes('?') ? '&' : '?'}organizationId=${org}` : ''}`;
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const connectorCalls = () => state.rpcCalls.filter((call) => call.fn.startsWith('rag_connector_'));

const listMap = (l: Loaded, org?: string, offset?: number) => l.map.GET(req(withOrg(offset === undefined ? '/connector-map' : `/connector-map?offset=${offset}`, org)));
const createMap = (l: Loaded, body: unknown, org?: string) => l.map.POST(req(withOrg('/connector-map', org), { method: 'POST', body }));
const changeMap = (l: Loaded, id: string, body: unknown, org?: string) => l.mapId.PUT(req(withOrg(`/connector-map/${id}`, org), { method: 'PUT', body }), idParams(id));
const removeMap = (l: Loaded, id: string, org?: string) => l.mapId.DELETE(req(withOrg(`/connector-map/${id}`, org), { method: 'DELETE' }), idParams(id));
const driveGroup = (groupId: string, extra: Row = {}) => ({ provider: 'google-drive', kind: 'group', externalPrincipalId: SOURCE_GROUP, groupId, ...extra });

beforeEach(() => {
  state.mode = 'single-tenant';
  state.session = null;
  state.rpcCalls = [];
  state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [] };
  state.groups = { 's:default': [GROUP_A, GROUP_B], [`o:${ORG_O}`]: [GROUP_A, GROUP_B], [`o:${ORG_P}`]: [GROUP_P] };
  state.mappings = [];
  state.seen = [];
  state.rules = [];
  state.failClosed = {};
  state.nextId = 1;
  for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
});

describe('connector mapping routes (single-tenant operator)', () => {
  it('maps a Google Drive group to group-a and lists it as mapped, with visibility applying in single-tenant mode', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const created = await createMap(loaded, driveGroup(GROUP_A));
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ success: true, mapping: { groupId: GROUP_A, outcome: 'created' }, appliesAt: 'next_sync', visibilityApplies: true });
    expect(state.rpcCalls).toContainEqual({
      fn: 'rag_connector_map_set',
      args: { p_tenant_key: 's:default', p_id: null, p_provider: 'google-drive', p_kind: 'group', p_external_principal_id: SOURCE_GROUP, p_group_id: GROUP_A, p_actor: ADMIN_ID },
    });

    const listed = await listMap(loaded);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(await listed.json()).toEqual({
      success: true,
      personal: false,
      visibilityApplies: true,
      rows: [{ id: createdBody.mapping.id, provider: 'google-drive', kind: 'group', externalPrincipalId: SOURCE_GROUP, groupId: GROUP_A, documents: 0 }],
      total: 1,
      nextOffset: null,
    });
    expect(connectorCalls().every((call) => !('p_user_id' in call.args))).toBe(true);
  });

  it('lists seen unmapped source groups first with their fallen-back counts, 50 per page', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await createMap(loaded, driveGroup(GROUP_A))).status).toBe(201);
    state.seen = Array.from({ length: 55 }, (_, n) => ({ tenant: 's:default', provider: 'dropbox', kind: 'team', pid: `dbtid:${String(n).padStart(3, '0')}`, documents: 2 }));
    const first = await (await listMap(loaded)).json();
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]).toEqual({ id: null, provider: 'dropbox', kind: 'team', externalPrincipalId: 'dbtid:000', groupId: null, documents: 2 });
    expect(first.total).toBe(56);
    expect(first.nextOffset).toBe(50);
    const second = await (await listMap(loaded, undefined, 50)).json();
    expect(second.rows).toHaveLength(6);
    expect(second.rows.at(-1)).toMatchObject({ groupId: GROUP_A, externalPrincipalId: SOURCE_GROUP });
    expect(second.nextOffset).toBeNull();
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_connector_map_list').map((call) => call.args.p_offset)).toEqual([0, 50]);
    expect((await listMap(loaded, undefined, -1)).status).toBe(400);
  });

  it('answers 409 mapping_exists for a duplicate and 400 unknown_group for a group of another workspace', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await createMap(loaded, driveGroup(GROUP_A))).status).toBe(201);
    const duplicate = await createMap(loaded, driveGroup(GROUP_B));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ success: false, error: 'mapping_exists' });
    const foreign = await createMap(loaded, driveGroup(GROUP_P, { externalPrincipalId: 'group-y@example.org' }));
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ success: false, error: 'unknown_group' });
    expect(state.mappings).toHaveLength(1);
  });

  it('PUT changes the group, DELETE removes the mapping, unknown ids answer 404', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const { mapping } = await (await createMap(loaded, driveGroup(GROUP_A))).json();
    const changed = await changeMap(loaded, mapping.id, { groupId: GROUP_B });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ success: true, mapping: { id: mapping.id, groupId: GROUP_B, outcome: 'changed' }, appliesAt: 'next_sync' });
    expect(state.mappings[0].groupId).toBe(GROUP_B);
    const foreign = await changeMap(loaded, mapping.id, { groupId: GROUP_P });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ success: false, error: 'unknown_group' });

    expect((await changeMap(loaded, UNKNOWN, { groupId: GROUP_A })).status).toBe(404);
    const removed = await removeMap(loaded, mapping.id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true, removed: true, appliesAt: 'next_sync' });
    expect(state.mappings).toEqual([]);
    const again = await removeMap(loaded, mapping.id);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ success: false, error: 'not_found' });
  });

  it('refuses malformed bodies before any call', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const bodies = [
      driveGroup(GROUP_A, { provider: 'onedrive' }),
      driveGroup(GROUP_A, { kind: 'domain' }),
      driveGroup('group-a'),
      driveGroup(GROUP_A, { externalPrincipalId: '  ' }),
      driveGroup(GROUP_A, { extra: true }),
    ];
    for (const body of bodies) {
      const response = await createMap(loaded, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Invalid request data');
    }
    expect((await changeMap(loaded, 'not-a-uuid', { groupId: GROUP_A })).status).toBe(400);
    expect((await changeMap(loaded, UNKNOWN, { groupId: GROUP_A, provider: 'dropbox' })).status).toBe(400);
    expect(connectorCalls()).toEqual([]);
  });

  it('a member gets 403 and no session gets 401, with no call made', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    for (const response of [await listMap(loaded), await createMap(loaded, driveGroup(GROUP_A)), await changeMap(loaded, UNKNOWN, { groupId: GROUP_A }), await removeMap(loaded, UNKNOWN)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
    }
    state.session = null;
    expect((await listMap(loaded)).status).toBe(401);
    expect(connectorCalls()).toEqual([]);
  });
});

describe('connector mapping routes (multi-tenant organization admin)', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: MEMBER_A, role: 'member' },
    ];
  });

  it('maps within the organization and reports that mapping does not change visibility (A-10)', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const created = await createMap(loaded, driveGroup(GROUP_A), ORG_O);
    expect(created.status).toBe(201);
    expect((await created.json()).visibilityApplies).toBe(false);
    expect(state.mappings[0].tenant).toBe(`o:${ORG_O}`);
    const body = await (await listMap(loaded, ORG_O)).json();
    expect(body.visibilityApplies).toBe(false);
    expect(body.rows).toHaveLength(1);
  });

  it('a group of another organization answers 400 unknown_group; another organization is 403 Forbidden', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const foreign = await createMap(loaded, driveGroup(GROUP_P), ORG_O);
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ success: false, error: 'unknown_group' });

    state.rpcCalls = [];
    for (const response of [await listMap(loaded, ORG_P), await createMap(loaded, driveGroup(GROUP_P), ORG_P)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
    }
    expect(connectorCalls()).toEqual([]);
  });

  it('a member of the organization gets 403 Admin access required', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    const response = await createMap(loaded, driveGroup(GROUP_A), ORG_O);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
    expect(connectorCalls()).toEqual([]);
  });

  it('a personal workspace lists nothing and refuses writes without a call', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const listed = await listMap(loaded);
    expect(await listed.json()).toEqual({ success: true, personal: true, visibilityApplies: false, rows: [], total: 0, nextOffset: null });
    const write = await createMap(loaded, driveGroup(GROUP_A));
    expect(write.status).toBe(400);
    expect(await write.json()).toEqual({ success: false, error: 'personal_tenant' });
    expect(connectorCalls()).toEqual([]);
  });
});
