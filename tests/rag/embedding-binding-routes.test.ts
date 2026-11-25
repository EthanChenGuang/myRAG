import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const TENANT = 'o:00000000-0000-4000-8000-0000000000c1';
const GLOBAL = 'global-a-2048';
const SCOPED = 'scoped-b-1024';
const SCOPED_TWO = 'scoped-c-1024';
const BINDING_ACTIVE = '00000000-0000-4000-8000-0000000000d1';
const BINDING_STAGED = '00000000-0000-4000-8000-0000000000d2';
const BINDING_FREE = '00000000-0000-4000-8000-0000000000d3';
const BINDING_NEW = '00000000-0000-4000-8000-0000000000d9';
const DB_SECRET = 'connection reset by peer: secret text';
const CHUNK_TEXT = 'A neutral synthetic sentence stored as chunk content.';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

function profileRow(id: string, status: string): Row {
  return {
    id,
    provider: 'synthetic',
    model: `model-${id}`,
    dims: id.endsWith('2048') ? 2048 : 1024,
    storage: 'halfvec',
    status,
    query_instruction: null,
    score_calibration: {},
    activated_at: null,
    activated_by: null,
    previous_active_id: null,
    has_evidence: true,
    eval_evidence: { secret: 'evidence body' },
    created_at: '2026-11-01T00:00:00.000Z',
  };
}

function bindingRow(id: string, over: Row = {}): Row {
  return {
    id,
    doc_type: 'general',
    tenant_key: null,
    profile_id: SCOPED,
    status: 'available',
    previous_binding_id: null,
    has_evidence: false,
    baseline_global_profile: null,
    activated_at: null,
    activated_by: null,
    created_at: '2026-11-02T00:00:00.000Z',
    created_by: 'cli:operator',
    eval_evidence: { secret: 'evidence body' },
    ...over,
  };
}

const state = {
  admins: [] as string[],
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  sessionThrows: false,
  lookupFails: false,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
  bindings: [] as Row[],
  dbAvailable: true,
  domainSwitch: 'on',
};

function fakeGuardClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (table !== 'admin_users') throw new Error(`the guard read ${table}`);
          if (state.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
        },
      };
      return builder;
    },
  };
}

function respond(fn: string, args: Record<string, unknown>): RpcOutcome {
  const forced = state.outcomes[fn];
  if (forced) return forced;
  switch (fn) {
    case 'rag_list_embedding_profiles':
      return { data: [profileRow(GLOBAL, 'active'), profileRow(SCOPED, 'available'), profileRow(SCOPED_TWO, 'available')], error: null };
    case 'rag_list_embedding_profile_scopes':
      return { data: [{ id: SCOPED, doc_types: ['general', 'product_technical'] }, { id: SCOPED_TWO, doc_types: ['general'] }], error: null };
    case 'rag_list_embedding_bindings':
      return { data: state.bindings, error: null };
    case 'rag_reembed_count':
      return {
        data: [
          { tenant_key: 's:default', chunks: '8', chunks_missing: args.p_tenant_key === null ? '2' : '0', content_chars: '100', content: CHUNK_TEXT },
          ...(args.p_tenant_key === null ? [{ tenant_key: TENANT, chunks: '2', chunks_missing: '0', content_chars: '10' }] : []),
        ],
        error: null,
      };
    case 'rag_create_embedding_binding':
      state.bindings.push(bindingRow(BINDING_NEW, { doc_type: args.p_doc_type, tenant_key: args.p_tenant_key, profile_id: args.p_profile_id }));
      return { data: [{ binding_id: BINDING_NEW, binding_status: 'available', created: true }], error: null };
    case 'rag_set_embedding_binding_status':
      return { data: [{ binding_id: args.p_binding_id, binding_status: args.p_status }], error: null };
    case 'rag_activate_embedding_binding':
      state.bindings = state.bindings.map((row) => (row.id === args.p_binding_id ? { ...row, status: 'active', activated_by: args.p_actor } : row));
      return { data: [{ activated_binding: args.p_binding_id, previous_binding: BINDING_ACTIVE }], error: null };
    case 'rag_rollback_embedding_binding':
      return { data: [{ restored_binding: BINDING_FREE, rolled_back_binding: BINDING_ACTIVE }], error: null };
    case 'rag_deactivate_embedding_binding':
      return { data: [{ deactivated_binding: BINDING_ACTIVE }], error: null };
    default:
      return { data: [], error: null };
  }
}

function rpcClient() {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const outcome = respond(fn, args);
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
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.sessionThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeGuardClient(), getSupabase: () => ({}) }));
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({ adminClient: () => (state.dbAvailable ? (rpcClient() as never) : null) });
  const ingestDeps = await import('@/lib/rag/ingest/deps');
  ingestDeps.setIngestDepsForTests({ ingestEnv: () => ({ RAG_EMBEDDING_PROFILES: 'on', RAG_DOMAIN_EMBEDDINGS: state.domainSwitch }) });
  const activeProfile = await import('@/lib/rag/embeddings/active-profile');
  activeProfile.resetActiveProfileForTests();
  const bindings = await import('@/lib/rag/embeddings/bindings');
  bindings.resetBindingsForTests();
  const session = await import('@/lib/admin-session');
  const list = await import('@/app/api/rag/admin/embedding-bindings/route');
  const activate = await import('@/app/api/rag/admin/embedding-bindings/[id]/activate/route');
  const rollback = await import('@/app/api/rag/admin/embedding-bindings/rollback/route');
  const deactivate = await import('@/app/api/rag/admin/embedding-bindings/deactivate/route');
  return { session, list, activate, rollback, deactivate };
}

type Loaded = Awaited<ReturnType<typeof load>>;
type Init = { method?: string; cookie?: string; authorization?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> };

function req(url: string, init: Init = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const BASE = '/api/rag/admin/embedding-bindings';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (url: string, init: Init = {}) => req(url, { method: 'POST', ...init });
const KEY = { doc_type: 'general', tenant_key: null };
const cookieOf = (value: string | null) => `admin_session=${value}`;

interface RouteCase {
  name: string;
  call: (loaded: Loaded, init?: Init) => Promise<Response>;
}

const ROUTES: RouteCase[] = [
  { name: 'GET list', call: (l, init) => l.list.GET(req(BASE, init)) },
  {
    name: 'POST create',
    call: (l, init) => l.list.POST(post(BASE, { body: { action: 'create', doc_type: 'general', profile_id: SCOPED, tenant_key: null }, ...init })),
  },
  { name: 'POST activate', call: (l, init) => l.activate.POST(post(`${BASE}/${BINDING_STAGED}/activate`, init), params(BINDING_STAGED)) },
  { name: 'POST rollback', call: (l, init) => l.rollback.POST(post(`${BASE}/rollback`, { body: KEY, ...init })) },
  { name: 'POST deactivate', call: (l, init) => l.deactivate.POST(post(`${BASE}/deactivate`, { body: KEY, ...init })) },
];

describe('embedding binding admin routes', () => {
  let logged: string[];

  beforeEach(() => {
    state.admins = [ADMIN_ID, OTHER_ADMIN_ID];
    state.session = null;
    state.tokens = {};
    state.sessionThrows = false;
    state.lookupFails = false;
    state.rpcCalls = [];
    state.outcomes = {};
    state.dbAvailable = true;
    state.domainSwitch = 'on';
    state.bindings = [
      bindingRow(BINDING_ACTIVE, {
        status: 'active',
        has_evidence: true,
        baseline_global_profile: GLOBAL,
        activated_at: '2026-11-03T00:00:00.000Z',
        activated_by: 'cli:operator',
      }),
      bindingRow(BINDING_STAGED, { tenant_key: TENANT, profile_id: SCOPED_TWO, status: 'backfilling', has_evidence: true, baseline_global_profile: 'older-global-1' }),
      bindingRow(BINDING_FREE, { doc_type: 'product_technical' }),
    ];
    logged = [];
    for (const method of ['warn', 'error', 'log', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe.each(ROUTES)('$name fails closed', (route) => {
    it('without any credential gives 401 and runs no registry function', async () => {
      const loaded = await load();
      const response = await route.call(loaded);
      expect(response.status).toBe(401);
      expect((await response.json()).success).toBe(false);
      expect(state.rpcCalls).toEqual([]);
    });

    it('gives 403 to an authenticated user who is not an admin, by session, bearer token and signed cookie', async () => {
      const loaded = await load();
      state.session = { id: USER_ID };
      expect((await route.call(loaded)).status).toBe(403);
      expect((await route.call(loaded, { cookie: cookieOf(loaded.session.mintAdminSessionValue(USER_ID)) })).status).toBe(403);
      state.session = null;
      state.tokens = { 'token-user': USER_ID };
      expect((await route.call(loaded, { authorization: 'Bearer token-user' })).status).toBe(403);
      expect(state.rpcCalls).toEqual([]);
    });

    it('gives 401 to a forged admin_session cookie and to a signed cookie without the matching live session', async () => {
      const loaded = await load();
      expect((await route.call(loaded, { cookie: cookieOf(ADMIN_ID) })).status).toBe(401);
      expect((await route.call(loaded, { cookie: cookieOf(loaded.session.mintAdminSessionValue(ADMIN_ID)) })).status).toBe(401);
      expect(state.rpcCalls).toEqual([]);
    });

    it('gives 503 when the auth lookup throws or the admin_users lookup fails', async () => {
      const loaded = await load();
      state.sessionThrows = true;
      expect((await route.call(loaded)).status).toBe(503);
      state.sessionThrows = false;
      state.session = { id: ADMIN_ID };
      state.lookupFails = true;
      expect((await route.call(loaded)).status).toBe(503);
      expect(state.rpcCalls).toEqual([]);
    });

    it('admits a signed admin_session cookie with its live session, and a bearer token of an admin', async () => {
      const loaded = await load();
      state.session = { id: ADMIN_ID };
      const withCookie = await route.call(loaded, { cookie: cookieOf(loaded.session.mintAdminSessionValue(ADMIN_ID)) });
      expect([200, 201]).toContain(withCookie.status);
      state.session = null;
      state.tokens = { 'token-admin': ADMIN_ID };
      expect([200, 201]).toContain((await route.call(loaded, { authorization: 'Bearer token-admin' })).status);
    });
  });

  it('lists bindings with stale flag, evidence presence, model and scoped completeness for backfilling and active rows only', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.GET(req(BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.switch).toBe('on');
    expect(body.profiles_switch).toBe('on');
    expect(body.global_active).toBe(GLOBAL);
    expect(body.doc_types).toContain('general');
    expect(body.profiles.find((profile: Row) => profile.id === SCOPED)).toEqual({
      id: SCOPED,
      provider: 'synthetic',
      model: `model-${SCOPED}`,
      dims: 1024,
      status: 'available',
      doc_types: ['general', 'product_technical'],
    });
    expect(body.profiles.find((profile: Row) => profile.id === GLOBAL).doc_types).toBeNull();

    const byId = Object.fromEntries(body.bindings.map((binding: Row) => [binding.id, binding]));
    expect(byId[BINDING_ACTIVE]).toEqual({
      id: BINDING_ACTIVE,
      doc_type: 'general',
      tenant_key: null,
      profile_id: SCOPED,
      model: `model-${SCOPED}`,
      status: 'active',
      stale: false,
      has_evidence: true,
      baseline_global_profile: GLOBAL,
      previous_binding_id: null,
      activated_at: '2026-11-03T00:00:00.000Z',
      activated_by: 'cli:operator',
      created_at: '2026-11-02T00:00:00.000Z',
      completeness: { state: 'measured', chunks: 10, missing: 2, percent: 80 },
    });
    expect(byId[BINDING_STAGED].stale).toBe(false);
    expect(byId[BINDING_STAGED].tenant_key).toBe(TENANT);
    expect(byId[BINDING_STAGED].completeness).toEqual({ state: 'measured', chunks: 8, missing: 0, percent: 100 });
    expect(byId[BINDING_FREE].completeness).toBeNull();
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_reembed_count').map((call) => call.args)).toEqual([
      { p_profile_id: SCOPED, p_tenant_key: null },
      { p_profile_id: SCOPED_TWO, p_tenant_key: TENANT },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('evidence body');
    expect(text).not.toContain(CHUNK_TEXT);
    expect(text).not.toMatch(/eval_evidence|score_calibration|query_instruction|created_by/);
  });

  it('flags an active binding whose evidence names another global profile as stale, and skips counts on request', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.bindings[0] = { ...state.bindings[0], baseline_global_profile: 'older-global-1' };
    const body = await (await loaded.list.GET(req(`${BASE}?completeness=false`))).json();
    expect(body.bindings.find((binding: Row) => binding.id === BINDING_ACTIVE).stale).toBe(true);
    expect(body.bindings.every((binding: Row) => binding.completeness === null)).toBe(true);
    expect(state.rpcCalls.some((call) => call.fn === 'rag_reembed_count')).toBe(false);
    expect((await loaded.list.GET(req(`${BASE}?completeness=maybe`))).status).toBe(400);
  });

  it('reports the domain switch off and a count that cannot be read as unavailable, never complete', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.domainSwitch = 'off';
    state.outcomes.rag_reembed_count = { data: null, error: { code: 'XX000', message: DB_SECRET } };
    const body = await (await loaded.list.GET(req(BASE))).json();
    expect(body.switch).toBe('off');
    expect(body.bindings.find((binding: Row) => binding.id === BINDING_ACTIVE).completeness).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(body)).not.toContain('secret text');
  });

  it('answers 503 embedding_registry_unavailable without database text when the registry cannot be read', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_list_embedding_bindings = { data: null, error: { code: 'XX000', message: DB_SECRET } };
    const failed = await loaded.list.GET(req(BASE));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ success: false, error: 'embedding_registry_unavailable' });
    state.outcomes = {};
    state.dbAvailable = false;
    for (const route of ROUTES) {
      const response = await route.call(loaded);
      expect(response.status, route.name).toBe(503);
      expect((await response.json()).error, route.name).toBe('embedding_registry_unavailable');
    }
    expect(logged.join('\n')).not.toContain('secret text');
  });

  it('creates a binding: 201 with the row, the actor is admin:<user id> and never a header or the body', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.POST(
      post(BASE, {
        body: { action: 'create', doc_type: 'product_technical', profile_id: SCOPED, tenant_key: TENANT },
        headers: { 'x-actor-id': OTHER_ADMIN_ID },
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, binding_id: BINDING_NEW, status: 'available', created: true });
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_create_embedding_binding')).toEqual([
      {
        fn: 'rag_create_embedding_binding',
        args: { p_doc_type: 'product_technical', p_tenant_key: TENANT, p_profile_id: SCOPED, p_actor: `admin:${ADMIN_ID}` },
      },
    ]);
    expect(logged.join('\n')).not.toContain(ADMIN_ID);
  });

  it('answers 200 with created false when the binding already exists', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_create_embedding_binding = { data: [{ binding_id: BINDING_FREE, binding_status: 'available', created: false }], error: null };
    const response = await loaded.list.POST(post(BASE, { body: { action: 'create', doc_type: 'product_technical', profile_id: SCOPED, tenant_key: null } }));
    expect(response.status).toBe(200);
    expect((await response.json()).created).toBe(false);
  });

  it('sets a binding status to available, backfilling or retired and records the admin actor', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const status of ['backfilling', 'available', 'retired']) {
      const response = await loaded.list.POST(post(BASE, { body: { action: 'set_status', binding_id: BINDING_FREE, status } }));
      expect(response.status, status).toBe(200);
      expect(await response.json()).toEqual({ success: true, binding_id: BINDING_FREE, status });
    }
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_set_embedding_binding_status').map((call) => call.args.p_actor)).toEqual(
      Array(3).fill(`admin:${ADMIN_ID}`),
    );
  });

  it('gives 400 with details to invalid input before any registry function runs', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const bad: unknown[] = [
      { action: 'create', doc_type: 'memo', profile_id: SCOPED, tenant_key: null },
      { action: 'create', doc_type: 'general', profile_id: 'Bad Id!', tenant_key: null },
      { action: 'create', doc_type: 'general', profile_id: SCOPED },
      { action: 'create', doc_type: 'general', profile_id: SCOPED, tenant_key: 'tenant-one' },
      { action: 'create', doc_type: 'general', profile_id: SCOPED, tenant_key: null, actor: OTHER_ADMIN_ID },
      { action: 'set_status', binding_id: BINDING_FREE, status: 'active' },
      { action: 'set_status', binding_id: 'not-a-uuid', status: 'retired' },
      { action: 'delete', binding_id: BINDING_FREE },
      [1],
      'text',
    ];
    for (const body of bad) {
      const response = await loaded.list.POST(post(BASE, { body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid request data');
      expect(Array.isArray(json.details)).toBe(true);
    }
    const memo = await (await loaded.list.POST(post(BASE, { body: bad[0] }))).json();
    expect(memo.details.some((detail: { path: string }) => detail.path === 'doc_type')).toBe(true);
    expect((await loaded.list.POST(post(BASE, { rawBody: '{not json' }))).status).toBe(400);
    for (const body of [{}, { doc_type: 'memo', tenant_key: null }, { doc_type: 'general' }, { ...KEY, actor: OTHER_ADMIN_ID }, { doc_type: 'general', tenant_key: 'x' }]) {
      expect((await loaded.rollback.POST(post(`${BASE}/rollback`, { body }))).status, JSON.stringify(body)).toBe(400);
      expect((await loaded.deactivate.POST(post(`${BASE}/deactivate`, { body }))).status, JSON.stringify(body)).toBe(400);
    }
    for (const id of ['not-a-uuid', '../etc', '']) {
      expect((await loaded.activate.POST(post(`${BASE}/x/activate`), params(id))).status, id).toBe(400);
    }
    expect((await loaded.activate.POST(post(`${BASE}/x/activate`, { body: { actor: OTHER_ADMIN_ID } }), params(BINDING_STAGED))).status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it('activates a binding: 200 with the activated row and the previous binding, actor admin:<user id>', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.activate.POST(post(`${BASE}/${BINDING_STAGED}/activate`), params(BINDING_STAGED));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.previous).toBe(BINDING_ACTIVE);
    expect(body.activated).toMatchObject({ id: BINDING_STAGED, status: 'active', tenant_key: TENANT, profile_id: SCOPED_TWO, activated_by: `admin:${ADMIN_ID}` });
    expect(JSON.stringify(body)).not.toContain('evidence body');
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_activate_embedding_binding').map((call) => call.args)).toEqual([
      { p_binding_id: BINDING_STAGED, p_actor: `admin:${ADMIN_ID}` },
    ]);
  });

  it('maps every gate refusal to 409 binding_refused with the reason and the gate message, never 200 or 500', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_activate_embedding_binding = { data: null, error: { code: '55000', message: 'binding_refused: eval_missing' } };
    const refused = await loaded.activate.POST(post(`${BASE}/${BINDING_STAGED}/activate`), params(BINDING_STAGED));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ success: false, error: 'binding_refused', reason: 'binding_refused: eval_missing', detail: 'binding_refused: eval_missing' });

    const message = `binding_refused: incomplete (3 current ready general chunks have no vector for profile ${SCOPED})`;
    state.outcomes.rag_activate_embedding_binding = { data: null, error: { code: '55000', message } };
    const incomplete = await (await loaded.activate.POST(post(`${BASE}/${BINDING_STAGED}/activate`), params(BINDING_STAGED))).json();
    expect(incomplete).toEqual({ success: false, error: 'binding_refused', reason: 'binding_refused: incomplete', detail: message });

    state.outcomes.rag_rollback_embedding_binding = { data: null, error: { code: '55000', message: 'binding_refused: no_previous' } };
    const rollback = await loaded.rollback.POST(post(`${BASE}/rollback`, { body: KEY }));
    expect(rollback.status).toBe(409);
    expect((await rollback.json()).reason).toBe('binding_refused: no_previous');

    state.outcomes.rag_deactivate_embedding_binding = { data: null, error: { code: '55000', message: 'binding_refused: no_active' } };
    const deactivate = await loaded.deactivate.POST(post(`${BASE}/deactivate`, { body: KEY }));
    expect(deactivate.status).toBe(409);
    expect((await deactivate.json()).reason).toBe('binding_refused: no_active');

    state.outcomes.rag_create_embedding_binding = { data: null, error: { code: '22023', message: 'binding_refused: profile_scope_mismatch' } };
    const create = await loaded.list.POST(post(BASE, { body: { action: 'create', doc_type: 'general', profile_id: GLOBAL, tenant_key: null } }));
    expect(create.status).toBe(409);
    expect((await create.json()).reason).toBe('binding_refused: profile_scope_mismatch');

    state.outcomes.rag_set_embedding_binding_status = { data: null, error: { code: '55000', message: 'binding_refused: binding_is_active' } };
    const status = await loaded.list.POST(post(BASE, { body: { action: 'set_status', binding_id: BINDING_ACTIVE, status: 'retired' } }));
    expect(status.status).toBe(409);
    expect((await status.json()).reason).toBe('binding_refused: binding_is_active');
  });

  it('fails closed with 503 and no database text when the gate answers with anything it does not name', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_activate_embedding_binding = { data: null, error: { code: 'XX000', message: DB_SECRET } };
    const failed = await loaded.activate.POST(post(`${BASE}/${BINDING_STAGED}/activate`), params(BINDING_STAGED));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('secret text');
    state.outcomes.rag_activate_embedding_binding = { data: [], error: null };
    expect((await loaded.activate.POST(post(`${BASE}/${BINDING_STAGED}/activate`), params(BINDING_STAGED))).status).toBe(503);
    state.outcomes.rag_deactivate_embedding_binding = { data: null, error: { code: '42501', message: `permission denied: ${DB_SECRET}` } };
    expect((await loaded.deactivate.POST(post(`${BASE}/deactivate`, { body: KEY }))).status).toBe(503);
    expect(logged.join('\n')).not.toContain('secret text');
  });

  it('rolls back and deactivates: 200 with the result and the admin actor', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const rollback = await loaded.rollback.POST(post(`${BASE}/rollback`, { body: { doc_type: 'general', tenant_key: TENANT } }));
    expect(rollback.status).toBe(200);
    const rolled = await rollback.json();
    expect(rolled.success).toBe(true);
    expect(rolled.rolled_back).toBe(BINDING_ACTIVE);
    expect(rolled.restored.id).toBe(BINDING_FREE);
    const deactivate = await loaded.deactivate.POST(post(`${BASE}/deactivate`, { body: KEY }));
    expect(deactivate.status).toBe(200);
    expect(await deactivate.json()).toEqual({ success: true, deactivated: BINDING_ACTIVE });
    expect(state.rpcCalls.filter((call) => /rollback|deactivate/.test(call.fn)).map((call) => call.args)).toEqual([
      { p_doc_type: 'general', p_tenant_key: TENANT, p_actor: `admin:${ADMIN_ID}` },
      { p_doc_type: 'general', p_tenant_key: null, p_actor: `admin:${ADMIN_ID}` },
    ]);
  });
});
