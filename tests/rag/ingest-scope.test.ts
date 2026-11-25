import { describe, expect, test, vi } from 'vitest';
import { nangoOwnerScope, resolveAdminWorkspaceScope } from '@/lib/rag/tenant/ingest-scope';
import { scopeKey } from '@/lib/rag/tenant/scope';

const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const OWNER = '00000000-0000-4000-8000-0000000000d1';

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

const memberA: Member[] = [{ organization_id: ORG_O, user_id: ADMIN_A }];
const signal = () => new AbortController().signal;

function keyOf(result: Awaited<ReturnType<typeof resolveAdminWorkspaceScope>>): string {
  if (!result.ok) throw new Error(`expected a scope, got ${result.status} ${result.reason}`);
  return scopeKey(result.scope);
}

describe('resolveAdminWorkspaceScope', () => {
  test('single-tenant gives s:default for any input with no Supabase call', async () => {
    const { admin, calls } = fakeAdmin([]);
    for (const requestedOrganizationId of [undefined, null, ORG_O, 'not-a-uuid']) {
      const result = await resolveAdminWorkspaceScope({
        adminUserId: 'not-a-uuid',
        requestedOrganizationId,
        deploymentMode: 'single-tenant',
        admin,
        signal: signal(),
      });
      expect(keyOf(result)).toBe('s:default');
    }
    expect(calls).toHaveLength(0);
  });

  test('multi-tenant: a member admin naming an organization gets o:<id> through one membership query', async () => {
    const { admin, calls } = fakeAdmin(memberA);
    const callerSignal = signal();
    const result = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_A,
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      admin,
      signal: callerSignal,
    });
    expect(keyOf(result)).toBe(`o:${ORG_O}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: 'organization_members',
      filters: { organization_id: ORG_O, user_id: ADMIN_A },
    });
    expect(calls[0].signal).toBe(callerSignal);
  });

  test('multi-tenant: an admin without a membership row gets 403 not_member', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin(memberA);
    const result = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_B,
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      admin,
      signal: signal(),
    });
    expect(result).toEqual({ ok: false, status: 403, reason: 'not_member' });
    expect(warn).toHaveBeenCalledWith('[RAG Tenant] admin workspace scope refused', { reason: 'not_member' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ORG_O);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ADMIN_B);
    warn.mockRestore();
  });

  test('multi-tenant: a malformed organization id gets 403 invalid_organization without a query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, calls } = fakeAdmin(memberA);
    for (const requestedOrganizationId of ['not-a-uuid', 'undefined', '0', `${ORG_O}x`]) {
      const result = await resolveAdminWorkspaceScope({
        adminUserId: ADMIN_A,
        requestedOrganizationId,
        deploymentMode: 'multi-tenant',
        admin,
        signal: signal(),
      });
      expect(result).toEqual({ ok: false, status: 403, reason: 'invalid_organization' });
    }
    expect(calls).toHaveLength(0);
    warn.mockRestore();
  });

  test('multi-tenant: no organization (null, empty, "null" or absent) gives the admin personal scope u:<admin>', async () => {
    const { admin, calls } = fakeAdmin(memberA);
    for (const requestedOrganizationId of [undefined, null, '', 'null']) {
      const result = await resolveAdminWorkspaceScope({
        adminUserId: ADMIN_A,
        requestedOrganizationId,
        deploymentMode: 'multi-tenant',
        admin,
        signal: signal(),
      });
      expect(keyOf(result)).toBe(`u:${ADMIN_A}`);
    }
    expect(calls).toHaveLength(0);
  });

  test('multi-tenant: uppercase ids give the lowercase key and the lowercase query arguments', async () => {
    const { admin, calls } = fakeAdmin(memberA);
    const org = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_A.toUpperCase(),
      requestedOrganizationId: ORG_O.toUpperCase(),
      deploymentMode: 'multi-tenant',
      admin,
      signal: signal(),
    });
    expect(keyOf(org)).toBe(`o:${ORG_O}`);
    expect(calls[0].filters).toEqual({ organization_id: ORG_O, user_id: ADMIN_A });
    const personal = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_A.toUpperCase(),
      deploymentMode: 'multi-tenant',
      admin,
      signal: signal(),
    });
    expect(keyOf(personal)).toBe(`u:${ADMIN_A}`);
  });

  test('multi-tenant: a membership query error or a missing admin client gives 503 membership_unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = fakeAdmin(memberA, 'boom');
    const queryError = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_A,
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      admin: failing.admin,
      signal: signal(),
    });
    const noClient = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_A,
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      admin: null,
      signal: signal(),
    });
    expect(queryError).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    expect(noClient).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    warn.mockRestore();
  });

  test('multi-tenant: an already aborted signal is refused with 503 and never ok', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin(memberA);
    const controller = new AbortController();
    controller.abort();
    const result = await resolveAdminWorkspaceScope({
      adminUserId: ADMIN_A,
      requestedOrganizationId: ORG_O,
      deploymentMode: 'multi-tenant',
      admin,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, status: 503, reason: 'membership_unavailable' });
    warn.mockRestore();
  });

  test('multi-tenant: an admin id that is not a UUID is refused with 503 invalid_user', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, calls } = fakeAdmin(memberA);
    for (const adminUserId of ['admin', '', 'single-tenant-user']) {
      const result = await resolveAdminWorkspaceScope({
        adminUserId,
        requestedOrganizationId: ORG_O,
        deploymentMode: 'multi-tenant',
        admin,
        signal: signal(),
      });
      expect(result).toEqual({ ok: false, status: 503, reason: 'invalid_user' });
    }
    expect(calls).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('nangoOwnerScope', () => {
  test('multi-tenant: the connection owner gets u:<owner lowercased>', () => {
    const result = nangoOwnerScope({ ownerUserId: OWNER.toUpperCase(), deploymentMode: 'multi-tenant' });
    if (!result.ok) throw new Error('expected a scope');
    expect(result.scope.kind).toBe('personal');
    expect(scopeKey(result.scope)).toBe(`u:${OWNER}`);
  });

  test('multi-tenant: a missing or non-UUID owner gets 503 invalid_owner', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const ownerUserId of ['single-tenant-user', null, undefined, '', 'null']) {
      expect(nangoOwnerScope({ ownerUserId, deploymentMode: 'multi-tenant' })).toEqual({
        ok: false,
        status: 503,
        reason: 'invalid_owner',
      });
    }
    expect(warn).toHaveBeenCalledWith('[RAG Tenant] nango owner scope refused', { reason: 'invalid_owner' });
    warn.mockRestore();
  });

  test('single-tenant gives s:default whatever the owner value is', () => {
    for (const ownerUserId of [OWNER, 'single-tenant-user', null, undefined]) {
      const result = nangoOwnerScope({ ownerUserId, deploymentMode: 'single-tenant' });
      if (!result.ok) throw new Error('expected a scope');
      expect(result.scope.kind).toBe('single');
      expect(scopeKey(result.scope)).toBe('s:default');
    }
  });
});
