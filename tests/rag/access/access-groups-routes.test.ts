import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000022a1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000022a2';
const MEMBER_A = '00000000-0000-4000-8000-0000000022b1';
const MEMBER_B = '00000000-0000-4000-8000-0000000022b2';
const OUTSIDER = '00000000-0000-4000-8000-0000000022b3';
const ORG_O = '00000000-0000-4000-8000-0000000022c1';
const ORG_P = '00000000-0000-4000-8000-0000000022c2';
const GROUP_A = '00000000-0000-4000-8000-0000000022d1';
const GROUP_B = '00000000-0000-4000-8000-0000000022d2';

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome | ((args: Record<string, unknown>) => RpcOutcome)>,
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
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
      const result = run();
      return Promise.resolve({ data: result.data[0] ?? null, error: null });
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve(run()).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function fakeClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    from: (table: string) => query(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const configured = state.outcomes[fn];
      const outcome = typeof configured === 'function' ? configured(args) : (configured ?? { data: [], error: null });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
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
  const root = await import('@/app/api/rag/access-groups/route');
  const mine = await import('@/app/api/rag/access-groups/mine/route');
  return { root, mine };
}

function req(url: string, init: { method?: string; authorization?: string; body?: unknown; rawBody?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const groupRow = (id: string, key: string, extra: Row = {}) => ({ id, key, name: `Group ${key.slice(-1).toUpperCase()}`, source: 'manual', created_at: '2026-11-27T08:00:00.000Z', ...extra });
const accessCalls = () => state.rpcCalls.filter((call) => /^rag_(access_group|access_groups_list|access_member|access_my_groups)/.test(call.fn));

function resetState() {
  state.mode = 'single-tenant';
  state.session = null;
  state.tokens = {};
  state.rpcCalls = [];
  state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [] };
  state.outcomes = {
    rag_access_group_create: (args) => ({ data: [groupRow(GROUP_A, String(args.p_key))], error: null }),
    rag_access_groups_list: { data: [groupRow(GROUP_A, 'group-a', { member_count: 2, document_count: 3, cursor: 'Y3Vyc29y' })], error: null },
    rag_connector_map_list: { data: [], error: null },
  };
}

beforeEach(() => {
  resetState();
  process.env.RAG_DOC_ACCESS_GROUPS = 'on';
  for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  delete process.env.RAG_DOC_ACCESS_GROUPS;
});

const create = (l: Awaited<ReturnType<typeof load>>, body: unknown, org?: string) =>
  l.root.POST(req(`/api/rag/access-groups${org ? `?organizationId=${org}` : ''}`, { method: 'POST', body }));
const list = (l: Awaited<ReturnType<typeof load>>, org?: string) => l.root.GET(req(`/api/rag/access-groups${org ? `?organizationId=${org}` : ''}`));

describe('access group routes: create and list (single-tenant operator)', () => {
  it('an operator with an admin session creates group-a and sees it in the list with counts', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const created = await create(loaded, { key: 'group-a', name: 'Group A' });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(await created.json()).toEqual({
      success: true,
      group: { id: GROUP_A, key: 'group-a', name: 'Group A', source: 'manual', createdAt: '2026-11-27T08:00:00.000Z' },
    });
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_access_group_create', args: { p_tenant_key: 's:default', p_key: 'group-a', p_name: 'Group A', p_actor: ADMIN_ID } });

    const listed = await list(loaded);
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const body = await listed.json();
    expect(body.success).toBe(true);
    expect(body.personal).toBe(false);
    expect(body.enabled).toBe(true);
    expect(body.groups).toEqual([
      { id: GROUP_A, key: 'group-a', name: 'Group A', source: 'manual', createdAt: '2026-11-27T08:00:00.000Z', memberCount: 2, documentCount: 3 },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it('returns the alert inputs: unmapped source groups and the enforcement state', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const unmapped = (n: number) => ({ id: null, provider: 'google-drive', kind: 'group', external_principal_id: `source-${n}`, group_id: null, documents: 1, total: 3 });
    state.outcomes.rag_connector_map_list = {
      data: [unmapped(1), unmapped(2), { id: GROUP_B, provider: 'google-drive', kind: 'group', external_principal_id: 'source-3', group_id: GROUP_A, documents: 0, total: 3 }],
      error: null,
    };
    state.outcomes.rag_access_enforced = { data: true, error: null };
    const body = await (await list(loaded)).json();
    expect(body.alerts.unmappedSourceGroups).toBe(2);
    expect(body.alerts.enforcement).toMatchObject({ runningSwitch: 'on', databaseFlag: true, ready: false });
    expect(Array.isArray(body.alerts.enforcement.reasons)).toBe(true);
    expect(body.alerts.enforcement).not.toHaveProperty('embedGroup');
  });

  it('a member without an admin session gets 403 Admin access required and no call is made', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    for (const response of [await create(loaded, { key: 'group-a', name: 'Group A' }), await list(loaded)]) {
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
    }
    expect(accessCalls()).toEqual([]);
  });

  it('no session answers 401', async () => {
    const loaded = await load();
    expect((await list(loaded)).status).toBe(401);
    expect((await create(loaded, { key: 'group-a', name: 'Group A' })).status).toBe(401);
    expect(accessCalls()).toEqual([]);
  });

  it('maps key and conflict errors to the UI-SPEC 8.2 codes', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const upper = await create(loaded, { key: 'Group-A', name: 'Group A' });
    expect(upper.status).toBe(400);
    expect(await upper.json()).toEqual({ success: false, error: 'invalid_key' });
    const reserved = await create(loaded, { key: 'all', name: 'Everyone' });
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ success: false, error: 'reserved_key' });
    expect(accessCalls()).toEqual([]);

    state.outcomes.rag_access_group_create = { data: null, error: { code: '23505', message: 'group_exists' } };
    const repeated = await create(loaded, { key: 'group-a', name: 'Group A' });
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toEqual({ success: false, error: 'group_exists' });
  });

  it('a database failure answers 503 access_groups_unavailable without the database message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_access_group_create = { data: null, error: { code: 'XX000', message: 'connection reset by peer at host-x' } };
    const response = await create(loaded, { key: 'group-a', name: 'Group A' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'access_groups_unavailable' });
  });

  it('refuses extra fields (actor, tenant, keys) and malformed bodies with details', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const extra of [{ actorId: MEMBER_A }, { tenantKey: `o:${ORG_P}` }, { accessGroups: ['g:x'] }]) {
      const response = await create(loaded, { key: 'group-a', name: 'Group A', ...extra });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid request data');
      expect(body.details.length).toBeGreaterThan(0);
    }
    const noName = await create(loaded, { key: 'group-a', name: '  ' });
    expect((await noName.json()).details[0].path).toBe('name');
    const notJson = await loaded.root.POST(req('/api/rag/access-groups', { method: 'POST', rawBody: '{nope' }));
    expect(notJson.status).toBe(400);
    expect(accessCalls()).toEqual([]);
  });
});

describe('access group routes: organization admins (multi-tenant)', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: MEMBER_A, role: 'member' },
      { organization_id: ORG_O, user_id: MEMBER_B, role: 'member' },
      { organization_id: ORG_P, user_id: OUTSIDER, role: 'owner' },
    ];
  });

  it('an organization admin without an admin session creates and lists for their organization only', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const created = await create(loaded, { key: 'group-a', name: 'Group A' }, ORG_O);
    expect(created.status).toBe(201);
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_access_group_create', args: { p_tenant_key: `o:${ORG_O}`, p_key: 'group-a', p_name: 'Group A', p_actor: ORG_ADMIN_ID } });
    expect((await list(loaded, ORG_O)).status).toBe(200);
    expect(state.rpcCalls.find((call) => call.fn === 'rag_access_groups_list')?.args.p_tenant_key).toBe(`o:${ORG_O}`);

    state.rpcCalls = [];
    for (const response of [await create(loaded, { key: 'group-a', name: 'Group A' }, ORG_P), await list(loaded, ORG_P)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
    }
    expect(accessCalls()).toEqual([]);
  });

  it('accepts the organization in the body; a body naming another workspace than the query is refused', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    expect((await create(loaded, { organizationId: ORG_O, key: 'group-a', name: 'Group A' })).status).toBe(201);
    const mismatch = await create(loaded, { organizationId: ORG_P, key: 'group-a', name: 'Group A' }, ORG_O);
    expect(mismatch.status).toBe(400);
  });

  it('a member of the organization gets 403 Admin access required; an organization admin by bearer token is admitted', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    const member = await create(loaded, { key: 'group-a', name: 'Group A' }, ORG_O);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ success: false, error: 'Admin access required' });

    state.session = null;
    state.tokens = { 'token-org-admin': ORG_ADMIN_ID };
    const bearer = await loaded.root.GET(req(`/api/rag/access-groups?organizationId=${ORG_O}`, { authorization: 'Bearer token-org-admin' }));
    expect(bearer.status).toBe(200);
  });

  it('a deployment admin who is not an owner or admin of the organization gets 403 Forbidden', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await list(loaded, ORG_O);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
  });

  it('a personal workspace answers personal true with no groups', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await list(loaded);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, personal: true, groups: [], nextCursor: null, alerts: { unmappedSourceGroups: 0 } });
    expect(accessCalls()).toEqual([]);
    const write = await create(loaded, { key: 'group-a', name: 'Group A' });
    expect(write.status).toBe(400);
    expect(await write.json()).toEqual({ success: false, error: 'personal_tenant' });
  });
});

describe('access group routes: GET /mine', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: MEMBER_A, role: 'member' },
    ];
    state.outcomes.rag_access_my_groups = (args) => ({
      data:
        args.p_user_id === MEMBER_A
          ? [{ is_admin: false, own_groups: [{ id: GROUP_A, name: 'Group A' }], assignable_groups: [{ id: GROUP_A, name: 'Group A' }] }]
          : [{ is_admin: true, own_groups: [], assignable_groups: [{ id: GROUP_A, name: 'Group A' }, { id: GROUP_B, name: 'Group B' }] }],
      error: null,
    });
  });

  const mine = (l: Awaited<ReturnType<typeof load>>, org?: string) => l.mine.GET(req(`/api/rag/access-groups/mine${org ? `?organizationId=${org}` : ''}`));

  it('member-a reads their own and assignable groups and nothing else', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    const response = await mine(loaded, ORG_O);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      enabled: true,
      personal: false,
      isAdmin: false,
      ownGroups: [{ id: GROUP_A, name: 'Group A' }],
      assignableGroups: [{ id: GROUP_A, name: 'Group A' }],
    });
    expect(state.rpcCalls.filter((call) => call.fn.startsWith('rag_'))).toEqual([
      { fn: 'rag_access_my_groups', args: { p_tenant_key: `o:${ORG_O}`, p_user_id: MEMBER_A } },
    ]);
  });

  it('the caller id comes from the session, never the query', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    await loaded.mine.GET(req(`/api/rag/access-groups/mine?organizationId=${ORG_O}&userId=${ORG_ADMIN_ID}`));
    expect(state.rpcCalls.find((call) => call.fn === 'rag_access_my_groups')?.args.p_user_id).toBe(MEMBER_A);
  });

  it('with the switch off answers enabled false only, without a database call', async () => {
    process.env.RAG_DOC_ACCESS_GROUPS = 'off';
    const loaded = await load();
    state.session = { id: MEMBER_A };
    const response = await mine(loaded, ORG_O);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, enabled: false });
    expect(state.rpcCalls).toEqual([]);
  });

  it('needs a verified session and membership of the named workspace', async () => {
    const loaded = await load();
    expect((await mine(loaded, ORG_O)).status).toBe(401);
    state.session = { id: OUTSIDER };
    const outsider = await mine(loaded, ORG_O);
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toEqual({ success: false, error: 'Forbidden' });
    expect(accessCalls()).toEqual([]);
  });

  it('a personal workspace has no groups', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    expect(await (await mine(loaded)).json()).toEqual({ success: true, enabled: true, personal: true, isAdmin: false, ownGroups: [], assignableGroups: [] });
    expect(accessCalls()).toEqual([]);
  });
});
