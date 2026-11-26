import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0b000000-0000-4000-8000-00000000000b';
const ORG_UNKNOWN = '0c000000-0000-4000-8000-00000000000c';

interface FakeEntry {
  tenantKey: string;
  id: string;
}

const state = {
  admins: [] as string[],
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  sessionThrows: false,
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  backend: 'pgvector' as 'off' | 'pgvector' | 'redisvl',
  organizations: [ORG_A, ORG_B] as string[],
  entries: [] as FakeEntry[],
  invalidateCalls: [] as Array<{ tenantKey: string; documentIds: string[] | undefined }>,
  cacheAvailable: true,
  cacheThrows: false,
  dbAvailable: true,
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
          return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
        },
      };
      return builder;
    },
  };
}

function fakeAdminDb() {
  return {
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: { message: 'none' } }) } },
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
          if (table !== 'organizations') throw new Error(`the clear action read ${table}`);
          const id = filters.id as string;
          return Promise.resolve({ data: state.organizations.includes(id) ? { id } : null, error: null });
        },
      };
      return builder;
    },
  };
}

function fakeCache() {
  return {
    check: async () => null,
    store: async () => undefined,
    async invalidateTenant(scope: unknown, documentIds?: string[]) {
      const { scopeKey } = await import('@/lib/rag/tenant/scope');
      const tenantKey = scopeKey(scope as never);
      state.invalidateCalls.push({ tenantKey, documentIds });
      if (state.cacheThrows) throw new Error('backend down: secret detail');
      const before = state.entries.length;
      state.entries = state.entries.filter((entry) => entry.tenantKey !== tenantKey);
      return before - state.entries.length;
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
  vi.doMock('@/lib/deployment-mode', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return {
      ...original,
      getDeploymentMode: () => state.mode,
      isMultiTenant: () => state.mode === 'multi-tenant',
      isSingleTenant: () => state.mode !== 'multi-tenant',
    };
  });
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({
    adminClient: () => (state.dbAvailable ? (fakeAdminDb() as never) : null),
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_SEMANTIC_CACHE: state.backend }),
    semanticCacheAdmin: () => (state.cacheAvailable ? (fakeCache() as never) : null),
    semanticCache: () => {
      throw new Error('the clear action used the fail-open cache');
    },
  });
  const session = await import('@/lib/admin-session');
  const route = await import('@/app/api/rag/admin/semantic-cache/route');
  return { session, route };
}

type Loaded = Awaited<ReturnType<typeof load>>;

interface ReqInit {
  cookie?: string;
  authorization?: string;
  body?: unknown;
  rawBody?: string;
}

function post(loaded: Loaded, init: ReqInit = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? JSON.stringify(init.body ?? { tenantKey: 's:default' });
  return loaded.route.POST(new NextRequest('http://localhost/api/rag/admin/semantic-cache', { method: 'POST', headers, body }));
}

const cookieOf = (value: string | null) => `admin_session=${value}`;
const hash12 = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);

let logged: string[];

beforeEach(() => {
  state.admins = [ADMIN_ID];
  state.session = null;
  state.tokens = {};
  state.sessionThrows = false;
  state.mode = 'single-tenant';
  state.backend = 'pgvector';
  state.organizations = [ORG_A, ORG_B];
  state.entries = [
    { tenantKey: 's:default', id: 'e1' },
    { tenantKey: 's:default', id: 'e2' },
  ];
  state.invalidateCalls = [];
  state.cacheAvailable = true;
  state.cacheThrows = false;
  state.dbAvailable = true;
  logged = [];
  for (const method of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/deployment-mode');
  vi.resetModules();
});

describe('POST /api/rag/admin/semantic-cache fails closed (T-06-86)', () => {
  it('exports runtime nodejs and dynamic force-dynamic', async () => {
    const loaded = await load();
    expect(loaded.route.runtime).toBe('nodejs');
    expect(loaded.route.dynamic).toBe('force-dynamic');
  });

  it('gives 401 without a credential and clears nothing', async () => {
    const loaded = await load();
    const response = await post(loaded);
    expect(response.status).toBe(401);
    expect((await response.json()).success).toBe(false);
    expect(state.invalidateCalls).toHaveLength(0);
    expect(state.entries).toHaveLength(2);
  });

  it('gives 401 to a forged admin_session cookie and to the literal admin bearer', async () => {
    const loaded = await load();
    expect((await post(loaded, { cookie: cookieOf(ADMIN_ID) })).status).toBe(401);
    const signed = loaded.session.mintAdminSessionValue(ADMIN_ID) as string;
    const [id, expiry, signature] = signed.split('.');
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect((await post(loaded, { cookie: cookieOf(`${id}.${expiry}.${flipped}`) })).status).toBe(401);
    expect((await post(loaded, { authorization: 'Bearer admin' })).status).toBe(401);
    expect(state.invalidateCalls).toHaveLength(0);
  });

  it('gives 403 to a non-admin session, cookie or token', async () => {
    const loaded = await load();
    state.session = { id: USER_ID };
    expect((await post(loaded)).status).toBe(403);
    expect((await post(loaded, { cookie: cookieOf(loaded.session.mintAdminSessionValue(USER_ID)) })).status).toBe(403);
    state.session = null;
    state.tokens = { 'token-user': USER_ID };
    expect((await post(loaded, { authorization: 'Bearer token-user' })).status).toBe(403);
    expect(state.invalidateCalls).toHaveLength(0);
  });

  it('gives 503 when auth throws, when the cache backend is not configured and when the backend fails', async () => {
    const loaded = await load();
    state.sessionThrows = true;
    expect((await post(loaded)).status).toBe(503);
    state.sessionThrows = false;
    state.session = { id: ADMIN_ID };
    state.cacheAvailable = false;
    const unconfigured = await post(loaded);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ success: false, error: 'semantic_cache_unavailable' });
    state.cacheAvailable = true;
    state.cacheThrows = true;
    const failed = await post(loaded);
    expect(failed.status).toBe(503);
    const text = JSON.stringify(await failed.json());
    expect(text).toContain('semantic_cache_unavailable');
    expect(text).not.toContain('secret detail');
    expect(logged.join('\n')).not.toContain('secret detail');
  });
});

describe('POST /api/rag/admin/semantic-cache clears one tenant (D-44)', () => {
  it('an admin clears the single-tenant cache and gets { deleted } with no-store', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await post(loaded, { body: { tenantKey: 's:default' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, deleted: 2, backend: 'pgvector' });
    expect(state.invalidateCalls).toEqual([{ tenantKey: 's:default', documentIds: undefined }]);
  });

  it('an admin bearer token is admitted too', async () => {
    const loaded = await load();
    state.tokens = { 'token-admin': ADMIN_ID };
    const response = await post(loaded, { authorization: 'Bearer token-admin' });
    expect(response.status).toBe(200);
  });

  it('a malformed body, a malformed key or a key of the other deployment mode gets a structured 400', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const init of [
      { rawBody: '{not json' },
      { body: {} },
      { body: { tenantKey: 42 } },
      { body: { tenantKey: 's:default', extra: true } },
      { body: { tenantKey: 'default' } },
      { body: { tenantKey: `o:${ORG_A}` } },
    ]) {
      const response = await post(loaded, init);
      expect(response.status, JSON.stringify(init)).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe('string');
    }
    state.mode = 'multi-tenant';
    const wrongMode = await post(loaded, { body: { tenantKey: 's:default' } });
    expect(wrongMode.status).toBe(400);
    expect(await wrongMode.json()).toMatchObject({ success: false, error: 'invalid_tenant_key' });
    expect(state.invalidateCalls).toHaveLength(0);
  });

  it('RAG_SEMANTIC_CACHE=off answers { deleted: 0, backend: off } and calls nothing', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.backend = 'off';
    state.dbAvailable = false;
    const response = await post(loaded);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, deleted: 0, backend: 'off' });
    expect(state.invalidateCalls).toHaveLength(0);
    expect(state.entries).toHaveLength(2);
  });

  it('multi-tenant: clearing tenant A sends only A and leaves B intact', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.mode = 'multi-tenant';
    state.backend = 'redisvl';
    state.entries = [
      { tenantKey: `o:${ORG_A}`, id: 'a1' },
      { tenantKey: `o:${ORG_A}`, id: 'a2' },
      { tenantKey: `o:${ORG_A}`, id: 'a3' },
      { tenantKey: `o:${ORG_B}`, id: 'b1' },
      { tenantKey: `o:${ORG_B}`, id: 'b2' },
    ];
    const response = await post(loaded, { body: { tenantKey: `O:${ORG_A.toUpperCase()}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, deleted: 3, backend: 'redisvl' });
    expect(state.invalidateCalls).toEqual([{ tenantKey: `o:${ORG_A}`, documentIds: undefined }]);
    expect(state.entries.map((entry) => entry.id)).toEqual(['b1', 'b2']);
  });

  it('multi-tenant: an unknown organization gets 400 and the service client being down gets 503', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.mode = 'multi-tenant';
    const unknown = await post(loaded, { body: { tenantKey: `o:${ORG_UNKNOWN}` } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ success: false, error: 'unknown_tenant' });
    state.dbAvailable = false;
    const down = await post(loaded, { body: { tenantKey: `o:${ORG_A}` } });
    expect(down.status).toBe(503);
    expect(state.invalidateCalls).toHaveLength(0);
  });

  it('logs [Semantic Cache] with a hashed tenant key only', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.mode = 'multi-tenant';
    await post(loaded, { body: { tenantKey: `o:${ORG_A}` } });
    const lines = logged.filter((line) => line.includes('[Semantic Cache]'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join('\n')).toContain(hash12(`o:${ORG_A}`));
    expect(logged.join('\n')).not.toContain(ORG_A);
  });
});
