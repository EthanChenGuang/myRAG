import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ID, request } from '../helpers/admin-guard-fixture';

const EXPERT = '00000000-0000-4000-8000-0000000031a1';
const OTHER = '00000000-0000-4000-8000-0000000031a2';
const MISSING = '00000000-0000-4000-8000-0000000031ff';
const ORG_A = 'o:00000000-0000-4000-8000-0000000031c1';
const USER_KEY = `u:${EXPERT}`;

type Mode = 'single-tenant' | 'multi-tenant';
interface Grant {
  tenant_key: string;
  user_id: string;
  granted_by: string | null;
  created_at: string;
}

interface State {
  session: { id: string } | null;
  authThrows: boolean;
  lookupFails: boolean;
  admins: string[];
  users: Record<string, string>;
  grants: Grant[];
  calls: string[];
  mode: Mode;
}

let state: State;

function fakeAdmin(s: State) {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }),
      admin: {
        getUserById: async (id: string) => {
          s.calls.push(`getUserById:${id}`);
          const email = s.users[id];
          return email ? { data: { user: { id, email } }, error: null } : { data: { user: null }, error: { message: 'User not found' } };
        },
      },
    },
    from(table: string) {
      s.calls.push(`from:${table}`);
      const filters: Record<string, unknown> = {};
      let op: 'select' | 'delete' = 'select';
      const builder: Record<string, unknown> = {
        select: () => builder,
        abortSignal: () => builder,
        order: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        delete() {
          op = 'delete';
          return builder;
        },
        insert(row: Grant) {
          s.grants.push({ ...row, created_at: '2026-11-25T00:00:00.000Z' });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle() {
          if (table === 'admin_users') {
            if (s.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
            return Promise.resolve({ data: s.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
          }
          const hit = s.grants.find((g) => g.tenant_key === filters.tenant_key && g.user_id === filters.user_id);
          return Promise.resolve({ data: hit ?? null, error: null });
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          if (op === 'delete') {
            s.grants = s.grants.filter((g) => !(g.tenant_key === filters.tenant_key && g.user_id === filters.user_id));
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          const rows = s.grants.filter((g) => g.tenant_key === filters.tenant_key);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  const admin = fakeAdmin(state);
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, getSupabase: () => ({}), supabaseAdmin: admin }));
  vi.doMock('@/lib/deployment-mode', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/deployment-mode')>()),
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  return import('@/app/api/rag/admin/domain-experts/route');
}

const URL_BASE = '/api/rag/admin/domain-experts';

beforeEach(() => {
  state = {
    session: null,
    authThrows: false,
    lookupFails: false,
    admins: [ADMIN_ID],
    users: { [EXPERT]: 'Expert.Person@Example.ORG', [OTHER]: 'other@example.invalid' },
    grants: [],
    calls: [],
    mode: 'multi-tenant',
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('domain-experts route guard', () => {
  it.each(['GET', 'POST', 'DELETE'] as const)('%s answers 401, 403 and 503 before any grant read', async (method) => {
    const route = await loadRoute();
    const call = () =>
      route[method](
        request(method === 'GET' ? `${URL_BASE}?tenantKey=${ORG_A}` : URL_BASE, {
          method,
          ...(method === 'GET' ? {} : { body: { tenantKey: ORG_A, userId: EXPERT } }),
        }),
      );
    expect((await call()).status).toBe(401);
    state.session = { id: OTHER };
    expect((await call()).status).toBe(403);
    state.session = { id: ADMIN_ID };
    state.authThrows = true;
    expect((await call()).status).toBe(503);
    state.authThrows = false;
    state.lookupFails = true;
    expect((await call()).status).toBe(503);
    expect(state.calls.filter((c) => c === 'from:rag_domain_experts' || c.startsWith('getUserById'))).toEqual([]);
    expect(state.grants).toEqual([]);
  });
});

describe('domain-experts route (multi-tenant)', () => {
  beforeEach(() => {
    state.session = { id: ADMIN_ID };
  });

  it('rejects s:default, a malformed key and an unknown user with 400', async () => {
    const route = await loadRoute();
    const post = (body: unknown) => route.POST(request(URL_BASE, { method: 'POST', body }));
    expect((await post({ tenantKey: 's:default', userId: EXPERT })).status).toBe(400);
    expect((await post({ tenantKey: 'o:not-a-uuid', userId: EXPERT })).status).toBe(400);
    expect((await post({ tenantKey: ORG_A, userId: 'nope' })).status).toBe(400);
    const unknown = await post({ tenantKey: ORG_A, userId: MISSING });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ details: [{ path: 'userId' }] });
    expect(state.grants).toEqual([]);
  });

  it('grants with granted_by = the admin (201), is idempotent (200) and logs hashes only', async () => {
    const log = vi.spyOn(console, 'log');
    const route = await loadRoute();
    const first = await route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey: ORG_A.toUpperCase().replace('O:', 'o:'), userId: EXPERT } }));
    expect(first.status).toBe(201);
    expect(state.grants).toEqual([{ tenant_key: ORG_A, user_id: EXPERT, granted_by: ADMIN_ID, created_at: expect.any(String) }]);
    const second = await route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey: ORG_A, userId: EXPERT } }));
    expect(second.status).toBe(200);
    expect(state.grants).toHaveLength(1);
    const lines = log.mock.calls.filter((args) => args[0] === '[Review] grant');
    expect(lines).toHaveLength(1);
    const logged = JSON.stringify(lines[0]);
    expect(logged).not.toContain(EXPERT);
    expect(logged).not.toContain(ORG_A);
  });

  it('accepts personal u: keys', async () => {
    const route = await loadRoute();
    expect((await route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey: USER_KEY, userId: EXPERT } }))).status).toBe(201);
  });

  it('GET lists the tenant grants with e-mails masked to the domain', async () => {
    const route = await loadRoute();
    await route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey: ORG_A, userId: EXPERT } }));
    await route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey: USER_KEY, userId: OTHER } }));
    const res = await route.GET(request(`${URL_BASE}?tenantKey=${ORG_A}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants).toEqual([{ tenant_key: ORG_A, user_id: EXPERT, email: '***@example.org', granted_by: ADMIN_ID, created_at: expect.any(String) }]);
    expect(JSON.stringify(body)).not.toMatch(/Expert\.Person/i);
    expect((await route.GET(request(`${URL_BASE}?tenantKey=s:default`))).status).toBe(400);
    expect((await route.GET(request(URL_BASE))).status).toBe(400);
  });

  it('DELETE removes the grant with 204', async () => {
    const route = await loadRoute();
    await route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey: ORG_A, userId: EXPERT } }));
    const res = await route.DELETE(request(URL_BASE, { method: 'DELETE', body: { tenantKey: ORG_A, userId: EXPERT } }));
    expect(res.status).toBe(204);
    expect(state.grants).toEqual([]);
    expect((await route.DELETE(request(URL_BASE, { method: 'DELETE', body: { tenantKey: 's:default', userId: EXPERT } }))).status).toBe(400);
  });
});

describe('domain-experts route (single-tenant)', () => {
  beforeEach(() => {
    state.session = { id: ADMIN_ID };
    state.mode = 'single-tenant';
  });

  it('accepts only s:default', async () => {
    const route = await loadRoute();
    const post = (tenantKey: string) => route.POST(request(URL_BASE, { method: 'POST', body: { tenantKey, userId: EXPERT } }));
    expect((await post(ORG_A)).status).toBe(400);
    expect((await post(USER_KEY)).status).toBe(400);
    expect((await post('s:default')).status).toBe(201);
    expect(state.grants.map((g) => g.tenant_key)).toEqual(['s:default']);
  });
});
