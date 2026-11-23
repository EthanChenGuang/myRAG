import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_B = '00000000-0000-4000-8000-0000000000a2';
const PLAIN_USER = '00000000-0000-4000-8000-0000000000b1';
const SETTINGS_ID = '00000000-0000-4000-8000-00000000e001';

type Row = Record<string, unknown>;

const state = {
  admins: [] as string[],
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  settings: [] as Row[],
  adminQueries: 0,
  lookupFails: false,
};

function fakeAdmin() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op: 'select' | 'update' | 'insert' = 'select';
      let payload: Row = {};
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        update(next: Row) {
          op = 'update';
          payload = next;
          return builder;
        },
        insert(next: Row) {
          op = 'insert';
          payload = next;
          return builder;
        },
        maybeSingle() {
          if (table === 'admin_users') {
            state.adminQueries += 1;
            if (state.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
            return Promise.resolve({
              data: state.admins.includes(filters.id as string) ? { id: filters.id } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: state.settings[0] ?? null, error: null });
        },
        single() {
          if (op === 'update') Object.assign(state.settings[0], payload);
          if (op === 'insert') state.settings.push({ id: SETTINGS_ID, ...payload });
          return Promise.resolve({ data: state.settings[0], error: null });
        },
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: state.session } }) },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeAdmin(), getSupabase: () => ({}) }));
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => fakeAdmin() as never });
  const session = await import('@/lib/admin-session');
  const login = await import('@/app/api/admin/login/route');
  const check = await import('@/app/api/admin/check/route');
  const status = await import('@/app/api/admin/status/route');
  const settings = await import('@/app/api/admin/settings/route');
  return { session, login, check, status, settings };
}

function req(url: string, init: { method?: string; cookie?: string; authorization?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const cookieOf = (value: string) => `admin_session=${value}`;

describe('admin routes authentication', () => {
  beforeEach(() => {
    state.admins = [ADMIN_A];
    state.session = null;
    state.tokens = {};
    state.settings = [{ id: SETTINGS_ID, read_only_doc_dashboard: false }];
    state.adminQueries = 0;
    state.lookupFails = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('forged and unsigned cookies', () => {
    it('a bare admin uuid cookie is refused by settings, check and status', async () => {
      const { settings, check, status } = await load();
      const cookie = cookieOf(ADMIN_A);

      const get = await settings.GET(req('/api/admin/settings', { cookie }));
      const post = await settings.POST(
        req('/api/admin/settings', { method: 'POST', cookie, body: { read_only_doc_dashboard: true } }),
      );
      expect(get.status).toBe(401);
      expect(post.status).toBe(401);
      expect(state.settings[0].read_only_doc_dashboard).toBe(false);

      expect(await (await check.GET(req('/api/admin/check', { cookie }))).json()).toEqual({ isAdmin: false });
      expect((await (await status.GET(req('/api/admin/status', { cookie }))).json()).isAdmin).toBe(false);
    });

    it('a literal Bearer admin header is refused', async () => {
      const { settings } = await load();
      const response = await settings.GET(req('/api/admin/settings', { authorization: 'Bearer admin' }));
      expect(response.status).toBe(401);
    });

    it('check answers only for the caller and ignores a userId or email in the query', async () => {
      const { check } = await load();
      const response = await check.GET(req(`/api/admin/check?userId=${ADMIN_A}&email=admin@example.com`));
      expect(await response.json()).toEqual({ isAdmin: false });
      expect(state.adminQueries).toBe(0);
    });
  });

  describe('login', () => {
    it('a body userId without a session gives 401 and no Set-Cookie', async () => {
      const { login } = await load();
      const response = await login.POST(
        req('/api/admin/login', { method: 'POST', body: { email: 'admin@example.com', userId: ADMIN_A } }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('a signed-in non-admin gives 403 and no Set-Cookie', async () => {
      state.session = { id: PLAIN_USER };
      const { login } = await load();
      const response = await login.POST(
        req('/api/admin/login', { method: 'POST', body: { userId: ADMIN_A } }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('an admin session mints a signed HttpOnly SameSite=Lax cookie for the session user, not the body userId', async () => {
      state.session = { id: ADMIN_A };
      state.admins = [ADMIN_A, ADMIN_B];
      const { login, session } = await load();
      const response = await login.POST(
        req('/api/admin/login', { method: 'POST', body: { userId: ADMIN_B, email: 'someone@example.com' } }),
      );
      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/^admin_session=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=lax/i);
      expect(setCookie).toMatch(/Path=\//);
      const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(12 * 60 * 60);
      const value = decodeURIComponent(/^admin_session=([^;]+)/.exec(setCookie)![1]);
      expect(value.split('.')).toHaveLength(3);
      expect(session.verifyAdminSessionValue(value)).toEqual({ userId: ADMIN_A });
    });

    it('a Bearer access token for an admin also logs in', async () => {
      state.tokens = { 'token-a': ADMIN_A };
      const { login } = await load();
      const response = await login.POST(req('/api/admin/login', { method: 'POST', authorization: 'Bearer token-a' }));
      expect(response.status).toBe(200);
    });

    it('the cookie is Secure in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      state.session = { id: ADMIN_A };
      const { login } = await load();
      const response = await login.POST(req('/api/admin/login', { method: 'POST' }));
      expect(response.headers.get('set-cookie')).toMatch(/Secure/i);
    });
  });

  describe('signed cookie', () => {
    it('a tampered signature gives 401', async () => {
      const { settings, session } = await load();
      const value = session.mintAdminSessionValue(ADMIN_A)!;
      const [id, expiry, sig] = value.split('.');
      const flipped = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
      const response = await settings.GET(req('/api/admin/settings', { cookie: cookieOf(`${id}.${expiry}.${flipped}`) }));
      expect(response.status).toBe(401);
    });

    it('a signature moved onto another user or a later expiry gives 401', async () => {
      state.admins = [ADMIN_A, ADMIN_B];
      const { settings, session } = await load();
      const [, expiry, sig] = session.mintAdminSessionValue(ADMIN_A)!.split('.');
      const otherUser = await settings.GET(req('/api/admin/settings', { cookie: cookieOf(`${ADMIN_B}.${expiry}.${sig}`) }));
      const later = await settings.GET(
        req('/api/admin/settings', { cookie: cookieOf(`${ADMIN_A}.${Number(expiry) + 60}.${sig}`) }),
      );
      expect(otherUser.status).toBe(401);
      expect(later.status).toBe(401);
    });

    it('an expired cookie gives 401', async () => {
      const { settings, session } = await load();
      const value = session.mintAdminSessionValue(ADMIN_A, { nowMs: Date.now() - 13 * 60 * 60 * 1000 })!;
      const response = await settings.GET(req('/api/admin/settings', { cookie: cookieOf(value) }));
      expect(response.status).toBe(401);
    });

    it('a cookie signed with a different key gives 401', async () => {
      const { settings, session } = await load();
      const value = session.mintAdminSessionValue(ADMIN_A, { serviceKey: 'some-other-key' })!;
      const response = await settings.GET(req('/api/admin/settings', { cookie: cookieOf(value) }));
      expect(response.status).toBe(401);
    });

    it('a valid cookie for an admin reads and updates settings and is reported by check and status', async () => {
      const { settings, check, status, session } = await load();
      const cookie = cookieOf(session.mintAdminSessionValue(ADMIN_A)!);

      const get = await settings.GET(req('/api/admin/settings', { cookie }));
      expect(get.status).toBe(200);
      expect((await get.json()).read_only_doc_dashboard).toBe(false);

      const post = await settings.POST(
        req('/api/admin/settings', { method: 'POST', cookie, body: { read_only_doc_dashboard: true } }),
      );
      expect(post.status).toBe(200);
      expect(state.settings[0]).toMatchObject({ read_only_doc_dashboard: true, updated_by: ADMIN_A });

      expect(await (await check.GET(req('/api/admin/check', { cookie }))).json()).toEqual({ isAdmin: true });
      const statusBody = await (await status.GET(req('/api/admin/status', { cookie }))).json();
      expect(statusBody.isAdmin).toBe(true);
      expect(statusBody.settings.read_only_doc_dashboard).toBe(true);
    });

    it('admin_users is re-checked on every request, so a removed admin loses access at once', async () => {
      const { settings, check, session } = await load();
      const cookie = cookieOf(session.mintAdminSessionValue(ADMIN_A)!);
      expect((await settings.GET(req('/api/admin/settings', { cookie }))).status).toBe(200);
      state.admins = [];
      expect((await settings.GET(req('/api/admin/settings', { cookie }))).status).toBe(403);
      expect(await (await check.GET(req('/api/admin/check', { cookie }))).json()).toEqual({ isAdmin: false });
    });

    it('a failing admin_users lookup gives 503, never access', async () => {
      const { settings, session } = await load();
      const cookie = cookieOf(session.mintAdminSessionValue(ADMIN_A)!);
      state.lookupFails = true;
      expect((await settings.GET(req('/api/admin/settings', { cookie }))).status).toBe(503);
    });
  });

  describe('settings without the cookie', () => {
    it('no credentials gives 401', async () => {
      const { settings } = await load();
      expect((await settings.GET(req('/api/admin/settings'))).status).toBe(401);
    });

    it('a signed-in non-admin gives 403', async () => {
      state.session = { id: PLAIN_USER };
      const { settings } = await load();
      expect((await settings.GET(req('/api/admin/settings'))).status).toBe(403);
    });

    it('a signed-in admin passes through the guard', async () => {
      state.session = { id: ADMIN_A };
      const { settings } = await load();
      expect((await settings.GET(req('/api/admin/settings'))).status).toBe(200);
    });

    it('a non-boolean setting is rejected for an admin', async () => {
      state.session = { id: ADMIN_A };
      const { settings } = await load();
      const response = await settings.POST(
        req('/api/admin/settings', { method: 'POST', body: { read_only_doc_dashboard: 'yes' } }),
      );
      expect(response.status).toBe(400);
    });
  });

  describe('logging', () => {
    it('status never logs the Cookie header', async () => {
      const { status, session } = await load();
      const value = session.mintAdminSessionValue(ADMIN_A)!;
      const cookie = `${cookieOf(value)}; sb-access-token=secret-session-token`;
      await status.GET(req('/api/admin/status', { cookie }));
      await status.GET(req('/api/admin/status', { cookie: 'sb-access-token=secret-session-token' }));
      const logged = JSON.stringify([
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.warn).mock.calls,
        ...vi.mocked(console.error).mock.calls,
      ]);
      expect(logged).not.toContain('secret-session-token');
      expect(logged).not.toContain(value);
    });
  });
});
