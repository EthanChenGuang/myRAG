import { describe, expect, test, vi } from 'vitest';
import { resolveTenantScope } from '@/lib/rag/tenant/resolve-chat';
import { scopeKey } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const ORG_O_UPPER = ORG_O.toUpperCase();

interface Member {
  organization_id: string;
  user_id: string;
}

interface RecordedCall {
  table: string;
  filters: Record<string, string>;
  columns: string | null;
  signal: AbortSignal | undefined;
}

function fakeAdmin(members: Member[], failure?: string) {
  const calls: RecordedCall[] = [];
  const admin = {
    from(table: string) {
      const call: RecordedCall = { table, filters: {}, columns: null, signal: undefined };
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
          if (failure) return Promise.resolve({ data: null, error: { message: failure } });
          const row = members.find(
            (member) =>
              member.organization_id === call.filters.organization_id && member.user_id === call.filters.user_id,
          );
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
  return { admin: admin as never, calls };
}

const memberA: Member[] = [{ organization_id: ORG_O, user_id: USER_A }];
const signal = () => new AbortController().signal;
const userA = async () => ({ id: USER_A });
const userB = async () => ({ id: USER_B });
const noUser = async () => null;

function silence() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('resolveTenantScope single-tenant', () => {
  test('any caller gets s:default, with or without a session or organization', async () => {
    const { admin, calls } = fakeAdmin([]);
    for (const getUser of [noUser, userA]) {
      for (const requestedOrganizationId of [undefined, null, ORG_O, 'not-a-uuid']) {
        const result = await resolveTenantScope({
          requestedOrganizationId,
          deploymentMode: 'single-tenant',
          getUser,
          admin,
          signal: signal(),
        });
        expect(result.ok).toBe(true);
        if (!result.ok || !result.scope) throw new Error('expected a scope');
        expect(result.scope.kind).toBe('single');
        expect(scopeKey(result.scope)).toBe('s:default');
      }
    }
    expect(calls).toHaveLength(0);
  });

  test('the session is not even consulted', async () => {
    const getUser = vi.fn(userA);
    await resolveTenantScope({ deploymentMode: 'single-tenant', getUser, admin: null, signal: signal() });
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe('resolveTenantScope multi-tenant', () => {
  test('member A requesting O gets o:<O> after exactly one membership query', async () => {
    const { admin, calls } = fakeAdmin(memberA);
    const abort = signal();
    const result = await resolveTenantScope({
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin,
      signal: abort,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.scope) throw new Error('expected a scope');
    expect(result.scope.kind).toBe('org');
    expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('organization_members');
    expect(calls[0].columns).toBe('organization_id');
    expect(calls[0].filters).toEqual({ organization_id: ORG_O, user_id: USER_A });
    expect(calls[0].signal).toBe(abort);
  });

  test('an uppercase organization id is normalised before the query and the scope', async () => {
    const { admin, calls } = fakeAdmin(memberA);
    const result = await resolveTenantScope({
      requestedOrganizationId: ORG_O_UPPER,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin,
      signal: signal(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.scope) throw new Error('expected a scope');
    expect(scopeKey(result.scope)).toBe(`o:${ORG_O}`);
    expect(calls[0].filters.organization_id).toBe(ORG_O);
  });

  test.each([undefined, null, 'null', ''])('A with organizationId %j gets the personal scope without a query', async (requested) => {
    const { admin, calls } = fakeAdmin(memberA);
    const result = await resolveTenantScope({
      requestedOrganizationId: requested,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin,
      signal: signal(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.scope) throw new Error('expected a scope');
    expect(result.scope.kind).toBe('personal');
    expect(scopeKey(result.scope)).toBe(`u:${USER_A}`);
    expect(calls).toHaveLength(0);
  });

  test('non-member B requesting O gets 403 and the membership query is the only Supabase call', async () => {
    const warn = silence();
    const { admin, calls } = fakeAdmin(memberA);
    const result = await resolveTenantScope({
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      getUser: userB,
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 403, reason: 'not_a_member' });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('organization_members');
    expect(calls[0].filters.user_id).toBe(USER_B);
    warn.mockRestore();
  });

  test.each(['not-a-uuid', '12345', `${ORG_O}'; drop table x;--`, 'undefined'])(
    'a malformed organization id %j gets 403 without any query',
    async (requested) => {
      const warn = silence();
      const { admin, calls } = fakeAdmin(memberA);
      const result = await resolveTenantScope({
        requestedOrganizationId: requested,
        deploymentMode: 'multi-tenant',
        getUser: userA,
        admin,
        signal: signal(),
      });
      expect(result).toEqual({ ok: false, status: 403, reason: 'invalid_organization' });
      expect(calls).toHaveLength(0);
      warn.mockRestore();
    },
  );

  test('a non-string organization id gets 403 without any query', async () => {
    const warn = silence();
    const { admin, calls } = fakeAdmin(memberA);
    const result = await resolveTenantScope({
      requestedOrganizationId: { id: ORG_O } as unknown as string,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 403, reason: 'invalid_organization' });
    expect(calls).toHaveLength(0);
    warn.mockRestore();
  });

  test('no session gives no scope with reason no_tenant, whatever the body says', async () => {
    const { admin, calls } = fakeAdmin(memberA);
    for (const requested of [undefined, ORG_O, 'not-a-uuid']) {
      const result = await resolveTenantScope({
        requestedOrganizationId: requested,
        deploymentMode: 'multi-tenant',
        getUser: noUser,
        admin,
        signal: signal(),
      });
      expect(result).toEqual({ ok: true, scope: null, reason: 'no_tenant' });
    }
    expect(calls).toHaveLength(0);
  });

  test('a membership query error fails closed with 503, never a personal scope', async () => {
    const warn = silence();
    const { admin } = fakeAdmin(memberA, 'connection reset');
    const result = await resolveTenantScope({
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    warn.mockRestore();
  });

  test('a missing admin client fails closed with 503 when an organization is requested', async () => {
    const warn = silence();
    const result = await resolveTenantScope({
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin: null,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    warn.mockRestore();
  });

  test('an aborted signal fails closed with 503', async () => {
    const warn = silence();
    const controller = new AbortController();
    controller.abort();
    const { admin } = fakeAdmin(memberA);
    const result = await resolveTenantScope({
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      getUser: userA,
      admin,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    warn.mockRestore();
  });

  test('a throwing session lookup fails closed with 503', async () => {
    const warn = silence();
    const result = await resolveTenantScope({
      deploymentMode: 'multi-tenant',
      getUser: async () => {
        throw new Error('auth down');
      },
      admin: null,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'auth_unavailable' });
    warn.mockRestore();
  });

  test('logs carry reasons only, never ids', async () => {
    const warn = silence();
    const { admin } = fakeAdmin(memberA);
    await resolveTenantScope({
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      getUser: userB,
      admin,
      signal: signal(),
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('[RAG Tenant]');
    expect(logged).not.toContain(ORG_O);
    expect(logged).not.toContain(USER_B);
    warn.mockRestore();
  });
});
