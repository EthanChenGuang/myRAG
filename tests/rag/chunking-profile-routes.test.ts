import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const REPO_ROOT = path.resolve(__dirname, '../..');
const DOC_ID = '11111111-2222-4333-8444-555555555555';
const DB_SECRET = 'connection reset by peer: secret text';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

function profileRow(id: string, docType: string, status: string, over: Row = {}): Row {
  const legacy = id === 'legacy';
  return {
    id,
    doc_type: docType,
    child_tokens: legacy ? 512 : 256,
    parent_mode: legacy ? 'none' : 'fixed',
    parent_tokens: legacy ? null : 1024,
    status,
    preset: legacy ? 'custom' : '256/1024',
    previous_active_id: null,
    is_active: status === 'active',
    created_at: '2026-11-01T00:00:00.000Z',
    activated_at: null,
    activated_by: null,
    ...over,
  };
}

function coverageRow(docType: string, profileId: string, isActive: boolean, total: number, withChildren: number): Row {
  return {
    doc_type: docType,
    profile_id: profileId,
    is_active: isActive,
    current_ready_documents: total,
    documents_with_children: withChildren,
    missing_documents: total - withChildren,
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
  profiles: [] as Row[],
  coverage: [] as Row[],
  dbAvailable: true,
  buildCalls: [] as Array<Record<string, unknown>>,
  buildImpl: null as null | ((input: Record<string, unknown>) => Promise<unknown>),
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
    case 'rag_list_chunking_profiles':
      return { data: state.profiles, error: null };
    case 'rag_chunking_coverage':
      return { data: state.coverage, error: null };
    case 'rag_create_chunking_profile':
      return { data: [{ profile_id: args.p_id, doc_type: args.p_doc_type, status: 'building' }], error: null };
    case 'rag_activate_chunking_profile':
      return { data: [{ activated_profile: args.p_profile_id, previous_profile: 'legacy', doc_type: args.p_doc_type ?? 'contract_legal', changed: true }], error: null };
    case 'rag_rollback_chunking_profile':
      return { data: [{ restored_profile: 'legacy', rolled_back_profile: 'p256-1024', doc_type: args.p_doc_type }], error: null };
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
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
      ...original,
      runChunkingBuildStep: async (profileId: string, options: Record<string, unknown>) => {
        state.buildCalls.push({ profileId, ...options });
        if (state.buildImpl) return state.buildImpl({ profileId, ...options });
        return original.runChunkingBuildStep ? (original.runChunkingBuildStep as (...args: unknown[]) => unknown)(profileId, options) : null;
      },
    };
  });
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({ adminClient: () => (state.dbAvailable ? (rpcClient() as never) : null), ragEnv: () => ({}) });
  const session = await import('@/lib/admin-session');
  const list = await import('@/app/api/rag/admin/chunking-profiles/route');
  const validate = await import('@/app/api/rag/admin/chunking-profiles/validate/route');
  const report = await import('@/app/api/rag/admin/chunking-profiles/report/route');
  const build = await import('@/app/api/rag/admin/chunking-profiles/[id]/build/route');
  const activate = await import('@/app/api/rag/admin/chunking-profiles/[id]/activate/route');
  const rollback = await import('@/app/api/rag/admin/chunking-profiles/rollback/route');
  return { session, list, validate, report, build, activate, rollback };
}

type Loaded = Awaited<ReturnType<typeof load>>;

interface ReqInit {
  method?: string;
  cookie?: string;
  authorization?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function req(url: string, init: ReqInit = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cookieOf = (value: string | null) => `admin_session=${value}`;

const PROFILE_256 = { id: 'p256-1024-contract_legal', doc_type: 'contract_legal', child_tokens: 256, parent_mode: 'fixed', parent_tokens: 1024, preset: '256/1024' };
const PROFILE_TOO_BIG = { ...PROFILE_256, id: 'p9000', child_tokens: 9000, parent_tokens: 36000, preset: 'custom' };

interface RouteCase {
  name: string;
  call: (loaded: Loaded, init?: ReqInit) => Promise<Response>;
  ops: () => number;
}

const rpcCount = () => state.rpcCalls.length;
const buildCount = () => state.buildCalls.length + state.rpcCalls.length;

const TASK1_ROUTES: RouteCase[] = [
  { name: 'GET /api/rag/admin/chunking-profiles', call: (l, init) => l.list.GET(req('/api/rag/admin/chunking-profiles', init)), ops: rpcCount },
  {
    name: 'POST /api/rag/admin/chunking-profiles',
    call: (l, init) => l.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', body: PROFILE_256, ...init })),
    ops: rpcCount,
  },
  {
    name: 'POST /api/rag/admin/chunking-profiles/validate',
    call: (l, init) => l.validate.POST(req('/api/rag/admin/chunking-profiles/validate', { method: 'POST', body: PROFILE_256, ...init })),
    ops: rpcCount,
  },
  { name: 'GET /api/rag/admin/chunking-profiles/report', call: (l, init) => l.report.GET(req('/api/rag/admin/chunking-profiles/report', init)), ops: rpcCount },
];

const TASK2_ROUTES: RouteCase[] = [
  {
    name: 'POST /api/rag/admin/chunking-profiles/{id}/build',
    call: (l, init) => l.build.POST(req('/api/rag/admin/chunking-profiles/p256-1024/build', { method: 'POST', body: {}, ...init }), params('p256-1024')),
    ops: buildCount,
  },
  {
    name: 'POST /api/rag/admin/chunking-profiles/{id}/activate',
    call: (l, init) =>
      l.activate.POST(req('/api/rag/admin/chunking-profiles/p256-1024/activate', { method: 'POST', body: { doc_type: 'contract_legal' }, ...init }), params('p256-1024')),
    ops: rpcCount,
  },
  {
    name: 'POST /api/rag/admin/chunking-profiles/rollback',
    call: (l, init) => l.rollback.POST(req('/api/rag/admin/chunking-profiles/rollback', { method: 'POST', body: { doc_type: 'contract_legal' }, ...init })),
    ops: rpcCount,
  },
];

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
  state.buildCalls = [];
  state.buildImpl = async () => ({
    runId: 'run-1',
    profileId: 'p256-1024',
    docType: 'contract_legal',
    status: 'running',
    docsDone: 1,
    docsTotal: 3,
    more: true,
    gaps: [],
  });
  state.profiles = [
    profileRow('legacy', 'general', 'active'),
    profileRow('legacy', 'contract_legal', 'available'),
    profileRow('p256-1024', 'contract_legal', 'active', { previous_active_id: 'legacy', activated_by: ADMIN_ID }),
    profileRow('p128-512', 'general', 'building', { child_tokens: 128, parent_tokens: 512, preset: '128/512' }),
  ];
  state.coverage = [
    coverageRow('contract_legal', 'legacy', false, 5, 5),
    coverageRow('contract_legal', 'p256-1024', true, 5, 3),
    coverageRow('general', 'legacy', true, 10, 4),
    coverageRow('general', 'p128-512', false, 10, 0),
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
  vi.doUnmock('@/lib/rag');
  vi.resetModules();
});

function authMatrix(routes: RouteCase[]) {
  describe.each(routes)('$name fails closed', (route) => {
    it('without any credential gives 401 and runs no profile operation', async () => {
      const loaded = await load();
      const response = await route.call(loaded);
      expect(response.status).toBe(401);
      expect((await response.json()).success).toBe(false);
      expect(route.ops()).toBe(0);
    });

    it('gives 401 to a forged or unsigned admin_session cookie and to the literal admin bearer', async () => {
      const loaded = await load();
      expect((await route.call(loaded, { cookie: cookieOf(ADMIN_ID) })).status).toBe(401);
      const signed = loaded.session.mintAdminSessionValue(ADMIN_ID) as string;
      const [id, expiry, signature] = signed.split('.');
      const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
      expect((await route.call(loaded, { cookie: cookieOf(`${id}.${expiry}.${flipped}`) })).status).toBe(401);
      expect((await route.call(loaded, { authorization: 'Bearer admin' })).status).toBe(401);
      expect(route.ops()).toBe(0);
    });

    it('gives 403 to a signed cookie of a user outside admin_users and to a non-admin session or token', async () => {
      const loaded = await load();
      state.session = { id: USER_ID };
      expect((await route.call(loaded, { cookie: cookieOf(loaded.session.mintAdminSessionValue(USER_ID)) })).status).toBe(403);
      expect((await route.call(loaded)).status).toBe(403);
      state.session = null;
      state.tokens = { 'token-user': USER_ID };
      expect((await route.call(loaded, { authorization: 'Bearer token-user' })).status).toBe(403);
      expect(route.ops()).toBe(0);
    });

    it('gives 503 when auth throws and when the admin_users lookup fails', async () => {
      const loaded = await load();
      state.sessionThrows = true;
      expect((await route.call(loaded)).status).toBe(503);
      state.sessionThrows = false;
      state.session = { id: ADMIN_ID };
      state.lookupFails = true;
      expect((await route.call(loaded)).status).toBe(503);
      expect(route.ops()).toBe(0);
    });

    it('admits a signed admin cookie with its live session and an admin bearer token', async () => {
      const loaded = await load();
      state.session = { id: ADMIN_ID };
      const withCookie = await route.call(loaded, { cookie: cookieOf(loaded.session.mintAdminSessionValue(ADMIN_ID)) });
      expect(withCookie.status).toBeLessThan(300);
      expect(withCookie.headers.get('cache-control')).toBe('no-store');
      state.session = null;
      state.tokens = { 'token-admin': ADMIN_ID };
      const withToken = await route.call(loaded, { authorization: 'Bearer token-admin' });
      expect(withToken.status).toBeLessThan(300);
    });
  });
}

describe('chunking profile admin routes: list, create, validate, report', () => {
  authMatrix(TASK1_ROUTES);

  it('every route exports runtime nodejs and dynamic force-dynamic', async () => {
    const loaded = await load();
    for (const route of [loaded.list, loaded.validate, loaded.report, loaded.build, loaded.activate, loaded.rollback]) {
      expect(route.runtime).toBe('nodejs');
      expect(route.dynamic).toBe('force-dynamic');
    }
  });

  it('lists the profiles with the active pointer and missing_from_active per doc type, counts only', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.GET(req('/api/rag/admin/chunking-profiles'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.active.contract_legal).toBe('p256-1024');
    expect(body.active.general).toBe('legacy');
    expect(body.missing_from_active.contract_legal).toBe(2);
    expect(body.missing_from_active.general).toBe(0);
    for (const docType of ['financial_report', 'invoice_receipt', 'product_technical', 'scanned_image']) {
      expect(body.active[docType]).toBe('legacy');
      expect(body.missing_from_active[docType]).toBe(0);
    }
    const p256 = body.profiles.find((profile: Row) => profile.id === 'p256-1024');
    expect(p256).toMatchObject({
      doc_type: 'contract_legal',
      child_tokens: 256,
      parent_mode: 'fixed',
      parent_tokens: 1024,
      status: 'active',
      preset: '256/1024',
      is_active: true,
      previous_active_id: 'legacy',
      completeness: { current_ready_documents: 5, documents_with_children: 3, missing_documents: 2 },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(DOC_ID);
    expect(text).not.toMatch(/tenant_key|document_id|"name"/);
    expect(state.rpcCalls.map((call) => call.fn).sort()).toEqual(['rag_chunking_coverage', 'rag_list_chunking_profiles']);
  });

  it('answers 503 without database text when the registry cannot be read or the admin client is missing', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_chunking_coverage = { data: null, error: { code: 'XX000', message: DB_SECRET } };
    const failed = await loaded.list.GET(req('/api/rag/admin/chunking-profiles'));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('secret text');
    state.outcomes = {};
    state.dbAvailable = false;
    expect((await loaded.list.GET(req('/api/rag/admin/chunking-profiles'))).status).toBe(503);
    expect(logged.join('\n')).not.toContain('secret text');
  });

  it('refuses a profile whose child exceeds the embedding input with 400 and details, and creates nothing', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', body: PROFILE_TOO_BIG }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('invalid_chunking_profile');
    expect(body.details).toContainEqual({ path: 'child_tokens', message: 'child_exceeds_embedding_input' });
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_create_chunking_profile')).toEqual([]);
  });

  it('refuses a malformed body or the legacy id with 400 before any call', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const bad = await loaded.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', body: { ...PROFILE_256, child_tokens: 'many' } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).details.length).toBeGreaterThan(0);
    const legacy = await loaded.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', body: { ...PROFILE_256, id: 'legacy' } }));
    expect(legacy.status).toBe(400);
    const extra = await loaded.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', body: { ...PROFILE_256, actor: OTHER_ADMIN_ID } }));
    expect(extra.status).toBe(400);
    const notJson = await loaded.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', rawBody: '{nope' }));
    expect(notJson.status).toBe(400);
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_create_chunking_profile')).toEqual([]);
  });

  it('creates a 256/1024 profile as building with the top_k_parent_over_budget warning', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.POST(
      req('/api/rag/admin/chunking-profiles', { method: 'POST', body: PROFILE_256, headers: { 'x-actor-id': OTHER_ADMIN_ID } }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, profile_id: PROFILE_256.id, doc_type: 'contract_legal', status: 'building' });
    expect(body.warnings).toEqual(['top_k_parent_over_budget']);
    const create = state.rpcCalls.filter((call) => call.fn === 'rag_create_chunking_profile');
    expect(create).toHaveLength(1);
    expect(create[0]!.args).toMatchObject({ p_id: PROFILE_256.id, p_doc_type: 'contract_legal', p_child_tokens: 256, p_parent_tokens: 1024, p_preset: '256/1024' });
    expect(logged.join('\n')).toContain('[RAG Admin]');
    expect(logged.join('\n')).toContain(ADMIN_ID);
    expect(logged.join('\n')).not.toContain(OTHER_ADMIN_ID);
  });

  it('maps a duplicate profile to 409 without the database message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_create_chunking_profile = { data: null, error: { code: '23505', message: DB_SECRET } };
    const response = await loaded.list.POST(req('/api/rag/admin/chunking-profiles', { method: 'POST', body: PROFILE_256 }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('secret text');
  });

  it('validate returns the same findings as create would, and never writes', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const tooBig = await loaded.validate.POST(req('/api/rag/admin/chunking-profiles/validate', { method: 'POST', body: PROFILE_TOO_BIG }));
    expect(tooBig.status).toBe(200);
    expect(await tooBig.json()).toMatchObject({ success: true, valid: false, errors: ['child_exceeds_embedding_input'] });
    const ok = await loaded.validate.POST(req('/api/rag/admin/chunking-profiles/validate', { method: 'POST', body: PROFILE_256 }));
    expect(await ok.json()).toMatchObject({ success: true, valid: true, errors: [], warnings: ['top_k_parent_over_budget'] });
    const small = await loaded.validate.POST(
      req('/api/rag/admin/chunking-profiles/validate', { method: 'POST', body: { ...PROFILE_256, child_tokens: 128, parent_tokens: 512, preset: '128/512' } }),
    );
    expect(await small.json()).toMatchObject({ valid: true, errors: [], warnings: [] });
    const bad = await loaded.validate.POST(req('/api/rag/admin/chunking-profiles/validate', { method: 'POST', body: { id: 'x' } }));
    expect(bad.status).toBe(400);
    expect(state.rpcCalls.filter((call) => call.fn.startsWith('rag_create') || call.fn.startsWith('rag_activate'))).toEqual([]);
  });

  it('report returns the committed sweep report and decisions', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.report.GET(req('/api/rag/admin/chunking-profiles/report'));
    expect(response.status).toBe(200);
    const body = await response.json();
    const report = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/reports/chunking-sweep.json'), 'utf8'));
    const decisions = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'eval/decisions/chunking/index.json'), 'utf8'));
    expect(body.success).toBe(true);
    expect(body.report).toEqual(report);
    expect(body.decisions).toEqual(decisions);
  });

  it('report answers 500 with a code and one [RAG Admin] line when a committed file is invalid', async () => {
    vi.doMock(path.join(REPO_ROOT, 'eval/reports/chunking-sweep.json'), () => ({ default: { config_hash: 'not-a-report' } }));
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    logged = [];
    const response = await loaded.report.GET(req('/api/rag/admin/chunking-profiles/report'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: 'chunking_report_invalid' });
    expect(logged.filter((line) => line.includes('[RAG Admin]'))).toHaveLength(1);
    vi.doUnmock(path.join(REPO_ROOT, 'eval/reports/chunking-sweep.json'));
  });
});
