import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000052a1';
const MEMBER_ID = '00000000-0000-4000-8000-0000000052b1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000052b2';
const P_OWNER_ID = '00000000-0000-4000-8000-0000000052b3';
const ORG_O = '00000000-0000-4000-8000-0000000052c1';
const ORG_P = '00000000-0000-4000-8000-0000000052c2';
const SETTINGS_RPCS = /^rag_translation_/;

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };
type CountOutcome = { count: number | null; error: { message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  supported: 'en,it,zh',
  primary: 'en',
  translation: 'off',
  session: null as { id: string } | null,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
  counts: {} as Record<string, CountOutcome>,
  countFilters: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  translatorCalls: 0,
  embedderCalls: 0,
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const eqs: Record<string, unknown> = {};
  let head = false;
  const run = () => {
    if (head) {
      state.countFilters.push({ table, filters: { ...eqs } });
      const key = `${table}:${String(eqs.profile_id ?? '')}`;
      const outcome = state.counts[key] ?? state.counts[table] ?? { count: 0, error: null };
      return { data: null, ...outcome };
    }
    const rows = (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
    return { data: rows, error: null };
  };
  const builder = {
    select(_columns?: string, options?: { count?: string; head?: boolean }) {
      head = options?.head === true;
      return builder;
    },
    abortSignal: () => builder,
    order: () => builder,
    limit: () => builder,
    eq(column: string, value: unknown) {
      eqs[column] = value;
      filters.push((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    maybeSingle() {
      const result = run();
      return Promise.resolve({ data: (result.data as Row[] | null)?.[0] ?? null, error: null });
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
      getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }),
      admin: { getUserById: async () => ({ data: { user: null }, error: { message: 'not found' } }) },
    },
    from: (table: string) => query(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const outcome = state.outcomes[fn] ?? { data: [], error: null };
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
  process.env.RAG_SUPPORTED_LANGUAGES = state.supported;
  process.env.RAG_PRIMARY_LANGUAGE = state.primary;
  process.env.RAG_DOC_TRANSLATION = state.translation;
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({
    db: () => fakeClient() as never,
    ingestEnv: () => ({ RAG_DOC_TRANSLATION: state.translation }),
    embedDocuments: async () => {
      state.embedderCalls += 1;
      throw new Error('the embedder must not be called');
    },
  });
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({
    adminClient: () => fakeClient() as never,
    embedder: async () => {
      state.embedderCalls += 1;
      throw new Error('the embedder must not be called');
    },
    queryLlm: () => {
      state.translatorCalls += 1;
      throw new Error('no model call');
    },
  });
  return import('@/app/api/rag/admin/translation-settings/route');
}

type Route = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; body?: unknown; rawBody?: string } = {}) {
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  });
}

const get = (route: Route, org: string | null = null) => route.GET(req(`/api/rag/admin/translation-settings${org ? `?organizationId=${org}` : ''}`));
const put = (route: Route, body: unknown, org: string | null = null) =>
  route.PUT(req(`/api/rag/admin/translation-settings${org ? `?organizationId=${org}` : ''}`, { method: 'PUT', body }));

const settingsCalls = () => state.rpcCalls.filter((call) => SETTINGS_RPCS.test(call.fn));
const setCalls = () => state.rpcCalls.filter((call) => call.fn === 'rag_translation_settings_set');

function settingsRow(tenantKey: string, targets: string[], enabled: boolean): Row {
  return { tenant_key: tenantKey, target_languages: targets, enabled, updated_by: ADMIN_ID, updated_at: '2026-11-25T09:00:00.000Z' };
}

function resetState() {
  state.mode = 'single-tenant';
  state.supported = 'en,it,zh';
  state.primary = 'en';
  state.translation = 'off';
  state.session = null;
  state.rpcCalls = [];
  state.countFilters = [];
  state.translatorCalls = 0;
  state.embedderCalls = 0;
  state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [] };
  state.counts = {};
  state.outcomes = {
    rag_translation_settings_get: { data: [settingsRow('s:default', ['zh', 'en'], true)], error: null },
    rag_translation_settings_set: { data: [settingsRow('s:default', ['zh', 'en'], true)], error: null },
    rag_translation_coverage: {
      data: [
        { language: 'zh', translated: 3, eligible: 5 },
        { language: 'en', translated: 7, eligible: 7 },
      ],
      error: null,
    },
  };
}

function quiet() {
  for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
}

describe('translation settings route: deployment admin (single-tenant)', () => {
  beforeEach(() => {
    resetState();
    quiet();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const name of ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE', 'RAG_DOC_TRANSLATION']) delete process.env[name];
  });

  it('fails closed: 401 without a session, 403 to a non-admin, and no settings function runs', async () => {
    const route = await load();
    const anonymous = await get(route);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    expect((await put(route, { enabled: true, targets: ['it'] })).status).toBe(401);
    state.session = { id: MEMBER_ID };
    const denied = await get(route);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ success: false, error: 'Admin access required' });
    expect((await put(route, { enabled: true, targets: ['it'] })).status).toBe(403);
    expect(settingsCalls()).toEqual([]);
  });

  it('GET returns the settings, the supported languages in registry order, per-target coverage, the stale flag and the switch', async () => {
    state.session = { id: ADMIN_ID };
    state.counts = { chunk_translations: { count: 10, error: null }, chunk_translation_embeddings: { count: 10, error: null } };
    const route = await load();
    const response = await get(route);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      enabled: true,
      targets: ['zh', 'en'],
      supportedLanguages: ['zh', 'en', 'it'],
      languagesConfigured: true,
      monolingual: false,
      coverage: [
        { language: 'zh', done: 3, total: 5, gaps: null },
        { language: 'en', done: 7, total: 7, gaps: null },
      ],
      stale: false,
      deploymentSwitch: 'off',
      updatedAt: '2026-11-25T09:00:00.000Z',
    });
    expect(settingsCalls().map((call) => [call.fn, call.args.p_tenant_key])).toEqual([
      ['rag_translation_settings_get', 's:default'],
      ['rag_translation_coverage', 's:default'],
    ]);
  });

  it('GET reports stale translations when the active profile has fewer translation vectors than translations, and the switch state', async () => {
    state.session = { id: ADMIN_ID };
    state.translation = 'on';
    state.counts = { chunk_translations: { count: 10, error: null }, chunk_translation_embeddings: { count: 4, error: null } };
    const route = await load();
    const body = await (await get(route)).json();
    expect(body.stale).toBe(true);
    expect(body.deploymentSwitch).toBe('on');
    expect(state.countFilters.every((call) => call.filters.tenant_key === 's:default')).toBe(true);
    expect(state.countFilters.find((call) => call.table === 'chunk_translation_embeddings')?.filters.profile_id).toEqual(expect.any(String));
  });

  it('GET answers stale null when the counts cannot be read, and 503 without the database message when the settings cannot', async () => {
    state.session = { id: ADMIN_ID };
    state.counts = { chunk_translations: { count: null, error: { message: 'down' } } };
    let route = await load();
    expect((await (await get(route)).json()).stale).toBeNull();
    state.outcomes.rag_translation_settings_get = { data: null, error: { code: 'XX000', message: 'secret database detail' } };
    route = await load();
    const failed = await get(route);
    expect(failed.status).toBe(503);
    const text = await failed.text();
    expect(text).not.toContain('secret database detail');
    expect(JSON.parse(text)).toEqual({ success: false, error: 'Translation settings are unavailable' });
  });

  it('PUT stores the targets de-duplicated in registry order with the guard user as actor, and answers the saved settings', async () => {
    state.session = { id: ADMIN_ID };
    const route = await load();
    const response = await put(route, { enabled: true, targets: ['en', 'zh', 'en'] });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(setCalls()).toEqual([
      { fn: 'rag_translation_settings_set', args: { p_actor: ADMIN_ID, p_tenant_key: 's:default', p_targets: ['zh', 'en'], p_enabled: true } },
    ]);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.targets).toEqual(['zh', 'en']);
    expect(body.enabled).toBe(true);
  });

  it('PUT never starts a translation run and never calls a model or the embedder', async () => {
    state.session = { id: ADMIN_ID };
    state.translation = 'on';
    const route = await load();
    expect((await put(route, { enabled: true, targets: ['it'] })).status).toBe(200);
    expect(state.translatorCalls).toBe(0);
    expect(state.embedderCalls).toBe(0);
    const fns = state.rpcCalls.map((call) => call.fn);
    expect(fns.some((fn) => /enqueue|claim|pending_page|write_chunk_translations/.test(fn))).toBe(false);
  });

  it('PUT refuses a target outside the supported set with 400 target_not_supported and writes nothing', async () => {
    state.session = { id: ADMIN_ID };
    state.supported = 'en,zh';
    const route = await load();
    for (const targets of [['it'], ['en', 'it'], ['xx'], ['fr-CA']]) {
      const response = await put(route, { enabled: true, targets });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ success: false, error: 'target_not_supported' });
    }
    expect(setCalls()).toEqual([]);
  });

  it('PUT refuses any target in monolingual mode, and enabling without a target', async () => {
    state.session = { id: ADMIN_ID };
    state.supported = 'en';
    const route = await load();
    const mono = await put(route, { enabled: true, targets: ['en'] });
    expect(mono.status).toBe(400);
    expect(await mono.json()).toMatchObject({ success: false, error: 'target_not_supported', reason: 'monolingual' });
    const empty = await put(route, { enabled: true, targets: [] });
    expect(empty.status).toBe(400);
    expect((await empty.json()).details[0].path).toBe('targets');
    expect(setCalls()).toEqual([]);
    expect((await put(route, { enabled: false, targets: [] })).status).toBe(200);
    expect(setCalls()).toHaveLength(1);
  });

  it('PUT refuses targets with 503 languages_not_configured when no languages are configured, and GET shows the state', async () => {
    state.session = { id: ADMIN_ID };
    state.supported = '';
    state.primary = '';
    const route = await load();
    const response = await put(route, { enabled: true, targets: ['en'] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'languages_not_configured' });
    expect(setCalls()).toEqual([]);
    const body = await (await get(route)).json();
    expect(body.languagesConfigured).toBe(false);
    expect(body.supportedLanguages).toEqual([]);
  });

  it('PUT refuses unknown keys, wrong types, malformed JSON and an over-long list with 400', async () => {
    state.session = { id: ADMIN_ID };
    const route = await load();
    const bodies: unknown[] = [
      { enabled: true, targets: ['en'], tenantKey: 'o:other' },
      { enabled: true, targets: ['en'], actor: ADMIN_ID },
      { enabled: 'yes', targets: ['en'] },
      { targets: ['en'] },
      { enabled: true },
      { enabled: true, targets: Array.from({ length: 17 }, () => 'en') },
    ];
    for (const body of bodies) {
      const response = await put(route, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Invalid request data');
    }
    const malformed = await route.PUT(req('/api/rag/admin/translation-settings', { method: 'PUT', rawBody: '{nope' }));
    expect(malformed.status).toBe(400);
    expect(setCalls()).toEqual([]);
  });

  it('maps the SQL actor refusal to 403 and other database failures to 503 without their message', async () => {
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_translation_settings_set = { data: null, error: { code: '42501', message: 'not_admin' } };
    let route = await load();
    const denied = await put(route, { enabled: true, targets: ['it'] });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ success: false, error: 'Forbidden' });
    state.outcomes.rag_translation_settings_set = { data: null, error: { code: 'XX000', message: 'secret database detail' } };
    route = await load();
    const failed = await put(route, { enabled: true, targets: ['it'] });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('secret database detail');
  });
});

describe('translation settings route: organization admin admission (multi-tenant)', () => {
  beforeEach(() => {
    resetState();
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: MEMBER_ID, role: 'member' },
      { organization_id: ORG_P, user_id: P_OWNER_ID, role: 'owner' },
    ];
    state.outcomes.rag_translation_settings_get = { data: [settingsRow(`o:${ORG_O}`, ['it'], true)], error: null };
    state.outcomes.rag_translation_settings_set = { data: [settingsRow(`o:${ORG_O}`, ['it'], true)], error: null };
    state.outcomes.rag_translation_coverage = { data: [{ language: 'it', translated: 0, eligible: 2 }], error: null };
    quiet();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const name of ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE', 'RAG_DOC_TRANSLATION']) delete process.env[name];
  });

  it("admits an organization admin for that organization's tenant only", async () => {
    state.session = { id: ORG_ADMIN_ID };
    const route = await load();
    expect((await get(route, ORG_O)).status).toBe(200);
    expect((await put(route, { enabled: true, targets: ['it'] }, ORG_O)).status).toBe(200);
    expect(setCalls()).toEqual([
      { fn: 'rag_translation_settings_set', args: { p_actor: ORG_ADMIN_ID, p_tenant_key: `o:${ORG_O}`, p_targets: ['it'], p_enabled: true } },
    ]);
    expect(settingsCalls().every((call) => call.args.p_tenant_key === `o:${ORG_O}`)).toBe(true);
  });

  it('denies a member, an admin of another organization, and an organization admin who names no organization', async () => {
    const route = await load();
    state.session = { id: MEMBER_ID };
    expect((await get(route, ORG_O)).status).toBe(403);
    expect((await put(route, { enabled: true, targets: ['it'] }, ORG_O)).status).toBe(403);
    state.session = { id: P_OWNER_ID };
    expect((await get(route, ORG_O)).status).toBe(403);
    expect((await put(route, { enabled: true, targets: ['it'] }, ORG_O)).status).toBe(403);
    state.session = { id: ORG_ADMIN_ID };
    expect((await get(route)).status).toBe(403);
    expect((await put(route, { enabled: true, targets: ['it'] })).status).toBe(403);
    expect(settingsCalls()).toEqual([]);
  });

  it('refuses a body organizationId that differs from the query one', async () => {
    state.session = { id: ORG_ADMIN_ID };
    const route = await load();
    const response = await put(route, { enabled: true, targets: ['it'], organizationId: ORG_P }, ORG_O);
    expect(response.status).toBe(400);
    expect(setCalls()).toEqual([]);
  });
});
