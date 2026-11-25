import { describe, expect, test, vi } from 'vitest';
import { requireRagAdmin, type RagAdminDb } from '@/lib/rag/tenant/admin';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_UPPER = ADMIN.toUpperCase();
const OTHER = '00000000-0000-4000-8000-0000000000b1';

interface RecordedCall {
  table: string;
  columns: string | null;
  filters: Record<string, string>;
  signal: AbortSignal | undefined;
}

function fakeAdmin(opts: { admins: string[]; tokens?: Record<string, string>; queryError?: boolean; authThrows?: boolean }) {
  const calls: RecordedCall[] = [];
  const getUser = vi.fn(async (token: string) => {
    if (opts.authThrows) throw new Error('network');
    const id = opts.tokens?.[token];
    return id
      ? { data: { user: { id } }, error: null }
      : { data: { user: null }, error: { message: 'invalid jwt' } };
  });
  const admin = {
    auth: { getUser },
    from(table: string) {
      const call: RecordedCall = { table, columns: null, filters: {}, signal: undefined };
      calls.push(call);
      const query = {
        select(columns: string) {
          call.columns = columns;
          return query;
        },
        eq(column: string, value: string) {
          call.filters[column] = value;
          return query;
        },
        abortSignal(signal: AbortSignal) {
          call.signal = signal;
          return query;
        },
        maybeSingle() {
          if (opts.queryError) return Promise.resolve({ data: null, error: { message: 'boom' } });
          const hit = opts.admins.includes(call.filters.id);
          return Promise.resolve({ data: hit ? { id: call.filters.id } : null, error: null });
        },
      };
      return query;
    },
  } as unknown as RagAdminDb;
  return { admin, calls, getUser };
}

const signal = () => new AbortController().signal;
const headers = (authorization?: string) => new Headers(authorization ? { authorization } : {});

describe('requireRagAdmin', () => {
  test('a verified cookie user in admin_users passes with the id lowercased', async () => {
    const { admin, calls } = fakeAdmin({ admins: [ADMIN] });
    const result = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => ({ id: ADMIN_UPPER }),
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: true, userId: ADMIN });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'admin_users', columns: 'id', filters: { id: ADMIN } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test('a Bearer token that getUser resolves to an admin passes', async () => {
    const { admin, getUser } = fakeAdmin({ admins: [ADMIN], tokens: { 'tok-a': ADMIN } });
    const result = await requireRagAdmin({ headers: headers('Bearer tok-a'), admin, signal: signal() });
    expect(result).toEqual({ ok: true, userId: ADMIN });
    expect(getUser).toHaveBeenCalledWith('tok-a');
  });

  test('a Bearer token for a user outside admin_users gives 403 not_admin', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN], tokens: { 'tok-o': OTHER } });
    const result = await requireRagAdmin({ headers: headers('Bearer tok-o'), admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 403, reason: 'not_admin' });
  });

  test('the literal Bearer admin is rejected without asking Supabase', async () => {
    const { admin, getUser, calls } = fakeAdmin({ admins: [ADMIN], tokens: { admin: ADMIN } });
    const result = await requireRagAdmin({ headers: headers('Bearer admin'), admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
    expect(getUser).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  test('a token that getUser rejects gives 401 invalid_session', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN] });
    const result = await requireRagAdmin({ headers: headers('Bearer forged'), admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
  });

  test('a non-Bearer authorization header does not fall back to the cookie session', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN] });
    const getCookieUser = vi.fn(async () => ({ id: ADMIN }));
    const result = await requireRagAdmin({ headers: headers('Basic abc'), getCookieUser, admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
    expect(getCookieUser).not.toHaveBeenCalled();
  });

  test('no header and no cookie session gives 401 no_session', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN] });
    const result = await requireRagAdmin({ headers: headers(), getCookieUser: async () => null, admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 401, reason: 'no_session' });
  });

  test('a throwing cookie lookup gives 503 auth_unavailable', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN] });
    const result = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => {
        throw new Error('down');
      },
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'auth_unavailable' });
  });

  test('a throwing token lookup gives 503 auth_unavailable', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN], authThrows: true });
    const result = await requireRagAdmin({ headers: headers('Bearer tok-a'), admin, signal: signal() });
    expect(result).toEqual({ ok: false, status: 503, reason: 'auth_unavailable' });
  });

  test('a cookie user outside admin_users gives 403 not_admin', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN] });
    const result = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => ({ id: OTHER }),
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 403, reason: 'not_admin' });
  });

  test('an admin_users query error gives 503 admin_check_unavailable', async () => {
    const { admin } = fakeAdmin({ admins: [ADMIN], queryError: true });
    const result = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => ({ id: ADMIN }),
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'admin_check_unavailable' });
  });

  test('a missing admin client gives 503 admin_check_unavailable', async () => {
    const cookie = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => ({ id: ADMIN }),
      admin: null,
      signal: signal(),
    });
    const bearer = await requireRagAdmin({ headers: headers('Bearer tok-a'), admin: null, signal: signal() });
    expect(cookie).toEqual({ ok: false, status: 503, reason: 'admin_check_unavailable' });
    expect(bearer).toEqual({ ok: false, status: 503, reason: 'admin_check_unavailable' });
  });

  test('a user id that is not a UUID is refused', async () => {
    const { admin, calls } = fakeAdmin({ admins: ['admin'] });
    const result = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => ({ id: 'admin' }),
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 401, reason: 'invalid_session' });
    expect(calls).toHaveLength(0);
  });

  test('two calls make two admin_users queries and a revoked admin is refused at once', async () => {
    const admins = [ADMIN];
    const { admin, calls } = fakeAdmin({ admins });
    const input = { headers: headers(), getCookieUser: async () => ({ id: ADMIN }), admin, signal: signal() };
    expect((await requireRagAdmin(input)).ok).toBe(true);
    admins.length = 0;
    expect(await requireRagAdmin(input)).toEqual({ ok: false, status: 403, reason: 'not_admin' });
    expect(calls).toHaveLength(2);
  });

  test('the admin_users query receives the very AbortSignal the caller passed', async () => {
    const { admin, calls } = fakeAdmin({ admins: [ADMIN], tokens: { 'tok-a': ADMIN } });
    const cookieSignal = signal();
    await requireRagAdmin({ headers: headers(), getCookieUser: async () => ({ id: ADMIN }), admin, signal: cookieSignal });
    const bearerSignal = signal();
    await requireRagAdmin({ headers: headers('Bearer tok-a'), admin, signal: bearerSignal });
    expect(calls).toHaveLength(2);
    expect(calls[0].signal).toBe(cookieSignal);
    expect(calls[1].signal).toBe(bearerSignal);
  });

  test('an already aborted caller signal is refused with 503 and makes no admin_users query', async () => {
    const { admin, calls } = fakeAdmin({ admins: [ADMIN], tokens: { 'tok-a': ADMIN } });
    const controller = new AbortController();
    controller.abort();
    const cookie = await requireRagAdmin({
      headers: headers(),
      getCookieUser: async () => ({ id: ADMIN }),
      admin,
      signal: controller.signal,
    });
    const bearer = await requireRagAdmin({ headers: headers('Bearer tok-a'), admin, signal: controller.signal });
    expect(cookie).toEqual({ ok: false, status: 503, reason: 'admin_check_unavailable' });
    expect(bearer).toEqual({ ok: false, status: 503, reason: 'admin_check_unavailable' });
    expect(calls).toHaveLength(0);
  });

  test('the refusal log carries only the reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { admin } = fakeAdmin({ admins: [ADMIN] });
    await requireRagAdmin({ headers: headers('Bearer super-secret-token'), admin, signal: signal() });
    expect(warn).toHaveBeenCalledWith('[RAG Admin] admin request refused', { reason: 'invalid_session' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-token');
    warn.mockRestore();
  });
});
