import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const ORG_Y = '00000000-0000-4000-8000-0000000000c2';
const REPO_ROOT = path.resolve(__dirname, '../..');
const SECRET = 'secret-text-placeholder';
const PATTERN = 'K-[A-Z]{3}';

type Row = Record<string, unknown>;

interface PatternRow {
  tenant_key: string;
  id: string;
  name: string;
  pattern: string;
  flags: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  sessionThrows: false,
  lookupFails: false,
  tokens: {} as Record<string, string>,
  admins: [] as string[],
  members: [] as Array<{ organization_id: string; user_id: string }>,
  rows: [] as PatternRow[],
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcFails: false,
  seq: 0,
};

function nextId(): string {
  state.seq += 1;
  return `00000000-0000-4000-8000-${state.seq.toString(16).padStart(12, '0')}`;
}

function patternRow(tenantKey: string, name: string, pattern = PATTERN, flags = 'u', enabled = true): PatternRow {
  return { tenant_key: tenantKey, id: nextId(), name, pattern, flags, enabled, created_at: '2026-11-26T10:00:00.000Z', updated_at: '2026-11-26T10:00:00.000Z' };
}

function respond(data: Row[] | Row | string | null, error: { code: string; message: string } | null = null): RpcRequest {
  const response = { data, error } as RpcResponse;
  const request: RpcRequest = {
    abortSignal: () => request,
    then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
  };
  return request;
}

const publicRow = ({ tenant_key: _tenant, ...rest }: PatternRow) => rest as unknown as Row;

function fakeRpc(): RpcClient {
  return {
    rpc(fn, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      state.calls.push({ fn, args: a });
      if (state.rpcFails) return respond(null, { code: 'XX000', message: `connection reset: ${SECRET}` });
      const own = () => state.rows.filter((row) => row.tenant_key === a.p_tenant_key);
      if (fn === 'rag_identifier_patterns_list') return respond(own().map(publicRow));
      if (fn === 'rag_identifier_pattern_create') {
        if (own().length >= 20) return respond(null, { code: '54000', message: 'limit_reached: at most 20 patterns' });
        if (own().some((row) => row.name === a.p_name)) return respond(null, { code: '23505', message: 'name_exists' });
        const row = patternRow(a.p_tenant_key as string, a.p_name as string, a.p_pattern as string, a.p_flags as string, a.p_enabled as boolean);
        state.rows.push(row);
        return respond([publicRow(row)]);
      }
      if (fn === 'rag_identifier_pattern_update') {
        const row = own().find((entry) => entry.id === a.p_id);
        if (!row) return respond(null, { code: 'P0002', message: 'pattern_not_found' });
        if (typeof a.p_name === 'string' && own().some((entry) => entry.id !== row.id && entry.name === a.p_name)) {
          return respond(null, { code: '23505', message: 'name_exists' });
        }
        if (typeof a.p_name === 'string') row.name = a.p_name;
        if (typeof a.p_pattern === 'string') row.pattern = a.p_pattern;
        if (typeof a.p_flags === 'string') row.flags = a.p_flags;
        if (typeof a.p_enabled === 'boolean') row.enabled = a.p_enabled;
        row.updated_at = '2026-11-26T11:00:00.000Z';
        return respond([publicRow(row)]);
      }
      if (fn === 'rag_identifier_pattern_delete') {
        const row = own().find((entry) => entry.id === a.p_id);
        if (!row) return respond(null, { code: 'P0002', message: 'pattern_not_found' });
        state.rows = state.rows.filter((entry) => entry !== row);
        return respond(row.id);
      }
      return respond([]);
    },
  };
}

function guardClient() {
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
        in: () => builder,
        maybeSingle() {
          if (table === 'admin_users') {
            if (state.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
            return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
          }
          if (table === 'organization_members') {
            const member = state.members.find((entry) => entry.organization_id === filters.organization_id && entry.user_id === filters.user_id);
            return Promise.resolve({ data: member ? { organization_id: member.organization_id } : null, error: null });
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
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
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => guardClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => fakeRpc() });
  const session = await import('@/lib/admin-session');
  const collection = await import('@/app/api/rag/admin/identifier-patterns/route');
  return { session, collection };
}

type Loaded = Awaited<ReturnType<typeof load>>;

interface ReqInit {
  method?: string;
  cookie?: string;
  authorization?: string;
  body?: unknown;
  rawBody?: string;
}

function req(url: string, init: ReqInit = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const cookieOf = (value: string | null) => `admin_session=${value}`;
const patternCalls = () => state.calls.filter((call) => /identifier_pattern/.test(call.fn));
const BASE = '/api/rag/admin/identifier-patterns';
const createBody = (extra: Record<string, unknown> = {}) => ({ name: 'Order code', pattern: PATTERN, flags: 'u', enabled: true, ...extra });

let logged: string[] = [];

beforeEach(() => {
  state.mode = 'multi-tenant';
  state.session = null;
  state.sessionThrows = false;
  state.lookupFails = false;
  state.tokens = {};
  state.admins = [ADMIN_ID, OTHER_ADMIN_ID];
  state.members = [];
  state.rows = [];
  state.calls = [];
  state.rpcFails = false;
  state.seq = 0;
  logged = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
  }
});

afterEach(async () => {
  const patterns = await import('@/lib/rag/identifiers/patterns');
  patterns.resetIdentifierPatternCacheForTests();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/deployment-mode');
});

describe('list and create: admin guard', () => {
  interface RouteCase {
    name: string;
    call: (loaded: Loaded, init?: ReqInit) => Promise<Response>;
    okStatus: number;
  }

  const ROUTES: RouteCase[] = [
    { name: 'GET', call: (l, init) => l.collection.GET(req(BASE, init)), okStatus: 200 },
    { name: 'POST', call: (l, init) => l.collection.POST(req(BASE, { method: 'POST', body: createBody(), ...init })), okStatus: 201 },
  ];

  describe.each(ROUTES)('$name /api/rag/admin/identifier-patterns', (route) => {
    it('answers the adminDenied 401 without a credential and calls no function', async () => {
      const loaded = await load();
      const response = await route.call(loaded);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ success: false, error: 'Admin authentication required' });
      expect(state.calls).toEqual([]);
    });

    it('answers 403 Admin access required to a signed-in user outside admin_users', async () => {
      const loaded = await load();
      state.session = { id: USER_A };
      const response = await route.call(loaded);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe('Admin access required');
      state.session = null;
      state.tokens = { 'token-user': USER_A };
      expect((await route.call(loaded, { authorization: 'Bearer token-user' })).status).toBe(403);
      expect(state.calls).toEqual([]);
    });

    it('answers 503 when the admin lookup fails', async () => {
      const loaded = await load();
      state.session = { id: ADMIN_ID };
      state.lookupFails = true;
      expect((await route.call(loaded)).status).toBe(503);
      expect(state.calls).toEqual([]);
    });

    it('admits a signed admin_session cookie with its live session and an admin bearer token', async () => {
      const loaded = await load();
      state.session = { id: ADMIN_ID };
      const cookie = cookieOf(loaded.session.mintAdminSessionValue(ADMIN_ID));
      const first = await route.call(loaded, { cookie });
      expect(first.status).toBe(route.okStatus);
      expect(first.headers.get('cache-control')).toBe('no-store');
      state.rows = [];
      state.session = null;
      state.tokens = { 'token-admin': ADMIN_ID };
      expect((await route.call(loaded, { authorization: 'Bearer token-admin' })).status).toBe(route.okStatus);
    });
  });
});

describe('GET /api/rag/admin/identifier-patterns', () => {
  it('lists the patterns of the admin workspace in creation order, with limits, and never another tenant', async () => {
    state.session = { id: ADMIN_ID };
    state.members = [{ organization_id: ORG_X, user_id: ADMIN_ID }];
    const first = patternRow(`o:${ORG_X}`, 'First');
    const second = patternRow(`o:${ORG_X}`, 'Second', '[A-Z]{2}-[A-Z]{2}', 'iu', false);
    state.rows = [patternRow(`u:${ADMIN_ID}`, 'Personal'), first, patternRow(`o:${ORG_Y}`, 'Foreign'), second];
    const { collection } = await load();

    const response = await collection.GET(req(`${BASE}?organizationId=${ORG_X}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      items: [
        { id: first.id, name: 'First', pattern: PATTERN, flags: 'u', enabled: true, updated_at: first.updated_at },
        { id: second.id, name: 'Second', pattern: '[A-Z]{2}-[A-Z]{2}', flags: 'iu', enabled: false, updated_at: second.updated_at },
      ],
      limits: { max_patterns: 20, max_pattern_length: 200, max_name_length: 80, max_sample_length: 10000 },
    });
    expect(patternCalls().map((call) => call.args.p_tenant_key)).toEqual([`o:${ORG_X}`]);

    const personal = await (await collection.GET(req(BASE))).json();
    expect(personal.items.map((item: Row) => item.name)).toEqual(['Personal']);
  });

  it('answers 403 Forbidden for an organization the admin is not a member of and calls no function', async () => {
    state.session = { id: ADMIN_ID };
    state.members = [{ organization_id: ORG_X, user_id: OTHER_ADMIN_ID }];
    state.rows = [patternRow(`o:${ORG_X}`, 'Foreign')];
    const { collection } = await load();
    const response = await collection.GET(req(`${BASE}?organizationId=${ORG_X}`));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
    expect(state.calls).toEqual([]);
  });

  it('keeps two organizations apart: each admin reads only the patterns of its own organization', async () => {
    state.members = [
      { organization_id: ORG_X, user_id: ADMIN_ID },
      { organization_id: ORG_Y, user_id: OTHER_ADMIN_ID },
    ];
    state.rows = [patternRow(`o:${ORG_X}`, 'X only'), patternRow(`o:${ORG_Y}`, 'Y only')];
    const { collection } = await load();
    state.session = { id: ADMIN_ID };
    expect((await (await collection.GET(req(`${BASE}?organizationId=${ORG_X}`))).json()).items.map((i: Row) => i.name)).toEqual(['X only']);
    expect((await collection.GET(req(`${BASE}?organizationId=${ORG_Y}`))).status).toBe(403);
    state.session = { id: OTHER_ADMIN_ID };
    expect((await (await collection.GET(req(`${BASE}?organizationId=${ORG_Y}`))).json()).items.map((i: Row) => i.name)).toEqual(['Y only']);
    expect((await collection.GET(req(`${BASE}?organizationId=${ORG_X}`))).status).toBe(403);
    expect(patternCalls().map((call) => call.args.p_tenant_key)).toEqual([`o:${ORG_X}`, `o:${ORG_Y}`]);
  });

  it('uses the deployment tenant in single-tenant mode and ignores organizationId', async () => {
    state.mode = 'single-tenant';
    state.session = { id: ADMIN_ID };
    state.rows = [patternRow('s:default', 'Deployment'), patternRow(`o:${ORG_Y}`, 'Other')];
    const { collection } = await load();
    const body = await (await collection.GET(req(`${BASE}?organizationId=${ORG_Y}`))).json();
    expect(body.items.map((item: Row) => item.name)).toEqual(['Deployment']);
    expect(patternCalls().map((call) => call.args.p_tenant_key)).toEqual(['s:default']);
  });

  it('answers 503 without the database message when the list fails', async () => {
    state.session = { id: ADMIN_ID };
    state.rpcFails = true;
    const { collection } = await load();
    const response = await collection.GET(req(BASE));
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);
  });
});

describe('POST /api/rag/admin/identifier-patterns', () => {
  it('creates a pattern in the resolved workspace and answers 201 with the item; the body cannot name a tenant', async () => {
    state.session = { id: ADMIN_ID };
    state.members = [{ organization_id: ORG_X, user_id: ADMIN_ID }];
    const { collection } = await load();
    const response = await collection.POST(req(BASE, { method: 'POST', body: createBody({ organizationId: ORG_X }) }));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      item: { id: expect.any(String), name: 'Order code', pattern: PATTERN, flags: 'u', enabled: true, updated_at: expect.any(String) },
    });
    const create = patternCalls().find((call) => call.fn === 'rag_identifier_pattern_create');
    expect(create?.args).toMatchObject({ p_tenant_key: `o:${ORG_X}`, p_name: 'Order code', p_pattern: PATTERN, p_flags: 'u', p_created_by: ADMIN_ID });
    expect(logged.some((line) => line.includes('[RAG Admin]') && line.includes('create_identifier_pattern') && line.includes(body.item.id))).toBe(true);
    expect(logged.join('\n')).not.toContain(PATTERN);
    expect(logged.join('\n')).not.toContain('Order code');

    for (const extra of [{ tenantKey: `o:${ORG_Y}` }, { tenant_key: `o:${ORG_Y}` }, { createdBy: OTHER_ADMIN_ID }]) {
      const refused = await collection.POST(req(BASE, { method: 'POST', body: createBody(extra) }));
      expect(refused.status, JSON.stringify(extra)).toBe(400);
    }
    expect(patternCalls().filter((call) => call.fn === 'rag_identifier_pattern_create')).toHaveLength(1);
  });

  it('answers 403 Forbidden and writes nothing for an organization the admin is not a member of', async () => {
    state.session = { id: ADMIN_ID };
    const { collection } = await load();
    const response = await collection.POST(req(BASE, { method: 'POST', body: createBody({ organizationId: ORG_Y }) }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('Forbidden');
    expect(state.calls).toEqual([]);
    expect(state.rows).toEqual([]);
  });

  it('writes to the deployment tenant in single-tenant mode', async () => {
    state.mode = 'single-tenant';
    state.session = { id: ADMIN_ID };
    const { collection } = await load();
    expect((await collection.POST(req(BASE, { method: 'POST', body: createBody({ organizationId: ORG_Y }) }))).status).toBe(201);
    expect(state.rows.map((row) => row.tenant_key)).toEqual(['s:default']);
  });

  it('answers 400 Invalid request data with a details path for schema failures and invalid JSON, before any call', async () => {
    state.session = { id: ADMIN_ID };
    const { collection } = await load();
    const cases: Array<[unknown, string]> = [
      [createBody({ extra: 1 }), ''],
      [createBody({ name: 'n'.repeat(81) }), 'name'],
      [createBody({ pattern: 'A'.repeat(201) }), 'pattern'],
      [createBody({ flags: 'g' }), 'flags'],
      [{ name: 'Only name' }, 'pattern'],
    ];
    for (const [body, pathName] of cases) {
      const response = await collection.POST(req(BASE, { method: 'POST', body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe('Invalid request data');
      expect(json.details.some((d: { path: string }) => d.path === pathName)).toBe(true);
    }
    const malformed = await collection.POST(req(BASE, { method: 'POST', rawBody: '{not json' }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ success: false, error: 'Invalid request data', details: [{ path: '', message: 'Body is not valid JSON' }] });
    expect(state.calls).toEqual([]);
  });

  it('answers 400 invalid_identifier_pattern with one details entry per finding code', async () => {
    state.session = { id: ADMIN_ID };
    const { collection } = await load();
    const nested = await collection.POST(req(BASE, { method: 'POST', body: createBody({ pattern: '(?:[A-Z]+)+-[0-9]' }) }));
    expect(nested.status).toBe(400);
    expect(await nested.json()).toEqual({
      success: false,
      error: 'invalid_identifier_pattern',
      details: [{ path: 'pattern', message: 'nested_unbounded_quantifier' }],
    });
    const broken = await (await collection.POST(req(BASE, { method: 'POST', body: createBody({ pattern: '[A-Z' }) }))).json();
    expect(broken.error).toBe('invalid_identifier_pattern');
    expect(broken.details).toEqual([{ path: 'pattern', message: 'invalid_regex' }]);
    const symbols = await (await collection.POST(req(BASE, { method: 'POST', body: createBody({ pattern: '#{2}' }) }))).json();
    expect(symbols.details.map((d: { message: string }) => d.message)).toEqual(['no_alphanumeric']);
    expect(patternCalls().filter((call) => call.fn === 'rag_identifier_pattern_create')).toEqual([]);
  });

  it('answers 409 limit_reached for the 21st pattern and 409 name_exists for a duplicate name', async () => {
    state.session = { id: ADMIN_ID };
    const { collection } = await load();
    state.rows = [patternRow(`u:${ADMIN_ID}`, 'Order code')];
    const duplicate = await collection.POST(req(BASE, { method: 'POST', body: createBody() }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ success: false, error: 'name_exists' });

    state.rows = Array.from({ length: 20 }, (_, i) => patternRow(`u:${ADMIN_ID}`, `Pattern ${i}`));
    const full = await collection.POST(req(BASE, { method: 'POST', body: createBody({ name: 'One more' }) }));
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ success: false, error: 'limit_reached' });
  });

  it('answers 503 and logs neither the database message nor the pattern when the write fails', async () => {
    state.session = { id: ADMIN_ID };
    const { collection } = await load();
    state.rpcFails = true;
    const response = await collection.POST(req(BASE, { method: 'POST', body: createBody() }));
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PATTERN);
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(PATTERN);
  });
});

describe('route sources', () => {
  const ROUTE_FILES = ['src/app/api/rag/admin/identifier-patterns/route.ts'];

  it.each(ROUTE_FILES)('%s uses checkAdmin, resolveAdminWorkspaceScope, zod/v3 and imports RAG code only from @/lib/rag', (file) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    expect(source).toMatch(/\bcheckAdmin\b/);
    expect(source).toMatch(/\bresolveAdminWorkspaceScope\b/);
    expect(source).toContain("from 'zod/v3'");
    expect(source).toContain("export const runtime = 'nodejs'");
    expect(source).not.toMatch(/@\/lib\/rag\//);
    expect(source).not.toMatch(/rag_identifier_pattern/);
  });
});
