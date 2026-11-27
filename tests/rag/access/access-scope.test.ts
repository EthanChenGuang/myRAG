import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  ACCESS_ADMIN_HASH,
  accessScopeTiming,
  accessTableFilter,
  bodyNamesAccessGroups,
  hashAccessKeys,
  resetAccessScopeLogForTests,
  resolveAccessScope,
  scopeAccessFilter,
  uploadAccessKeys,
  type AccessIdentity,
} from '@/lib/rag/tenant/access';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { resetAccessStartupForTests, verifyAccessGroupsStartup } from '@/lib/rag/tenant/access-startup';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000a2';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const GROUP_1 = '00000000-0000-4000-8000-0000000000f1';
const GROUP_2 = '00000000-0000-4000-8000-0000000000f2';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

type Responder = (call: Call) => RpcResponse | Promise<RpcResponse>;

function fakeClient(respond: Responder, calls: Call[]): RpcClient {
  return {
    rpc(fn, args) {
      const call = { fn, args };
      calls.push(call);
      const request = {
        abortSignal: () => request,
        then: (ok: (value: RpcResponse) => unknown, bad?: (reason: unknown) => unknown) =>
          Promise.resolve()
            .then(() => respond(call))
            .then(ok, bad),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
}

const ON = { accessGroups: 'on' as const };
const OFF = { accessGroups: 'off' as const };

let calls: Call[];
let warnSpy: MockInstance<typeof console.warn>;

function readyStartup(): Promise<unknown> {
  const client = fakeClient((call) => {
    if (call.fn === 'rag_access_set_enforced' || call.fn === 'rag_access_enforced') return { data: true, error: null };
    if (call.fn === 'rag_access_readiness') return { data: [{ ready: true, reasons: [], objects: [] }], error: null };
    return { data: [], error: null };
  }, []);
  return verifyAccessGroupsStartup({
    ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: 'on' }),
    adminClient: () => client,
    backendCapabilities: () => ({ accessFilter: true }),
  });
}

beforeEach(async () => {
  calls = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetAccessScopeLogForTests();
  resetAccessStartupForTests();
  await readyStartup();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRagDepsForTests();
  resetRagConfigForTests();
  resetAccessStartupForTests();
});

async function resolve(
  scope: TenantScope,
  identity: AccessIdentity,
  respond: Responder,
  config: { accessGroups: 'on' | 'off' } = ON,
  signal: AbortSignal = new AbortController().signal,
) {
  return resolveAccessScope({ scope, identity, signal, admin: fakeClient(respond, calls), config });
}

const resolverAnswer =
  (row: { is_admin: boolean; group_ids: string[]; effective_keys: string[] }): Responder =>
  () => ({ data: [row], error: null });

describe('resolveAccessScope', () => {
  test('switch off attaches mode off without any database call, the same access object each time', async () => {
    const scope = mintScope('single', null, null);
    const a = await resolve(scope, { kind: 'user', userId: USER_A }, () => ({ data: null, error: null }), OFF);
    const b = await resolve(scope, { kind: 'anonymous' }, () => ({ data: null, error: null }), OFF);
    expect(calls).toEqual([]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(scopeAccessFilter(a.scope)).toEqual({ mode: 'off' });
    expect(a.scope.access).toBe(b.scope.access);
    expect(scopeKey(a.scope)).toBe('s:default');
  });

  test('the owner of a personal scope gets admin_all with no call', async () => {
    const out = await resolve(mintScope('personal', USER_A, null), { kind: 'user', userId: USER_A }, () => ({ data: null, error: null }));
    expect(calls).toEqual([]);
    expect(out.ok && scopeAccessFilter(out.scope)).toEqual({ mode: 'admin_all' });
    if (out.ok) expect(out.scope.access?.setHash).toBe(ACCESS_ADMIN_HASH);
  });

  test('anonymous gets keys all with the hash of all and no call', async () => {
    const out = await resolve(mintScope('single', null, null), { kind: 'anonymous' }, () => ({ data: null, error: null }));
    expect(calls).toEqual([]);
    expect(out.ok && scopeAccessFilter(out.scope)).toEqual({ mode: 'keys', keys: ['all'], setHash: hashAccessKeys(['all']) });
  });

  test('a member makes exactly one resolver call and gets all, u:self and one g: key per group', async () => {
    const scope = mintScope('org', USER_A, ORG_O);
    const out = await resolve(
      scope,
      { kind: 'user', userId: USER_A },
      resolverAnswer({ is_admin: false, group_ids: [GROUP_2, GROUP_1], effective_keys: ['all', `g:${GROUP_1}`] }),
    );
    expect(calls).toEqual([{ fn: 'rag_resolve_access_scope', args: { p_tenant_key: `o:${ORG_O}`, p_user_id: USER_A } }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const filter = scopeAccessFilter(out.scope);
    expect(filter).toEqual({
      mode: 'keys',
      keys: ['all', `g:${GROUP_1}`, `g:${GROUP_2}`, `u:${USER_A}`],
      setHash: hashAccessKeys(['all', `g:${GROUP_1}`]),
    });
    expect(out.scope.userId).toBe(USER_A);
    expect(out.scope.organizationId).toBe(ORG_O);
  });

  test('the set hash depends on the effective keys only, not on their order or on keys that label nothing', async () => {
    const scope = mintScope('single', null, null);
    const a = await resolve(
      scope,
      { kind: 'user', userId: USER_A },
      resolverAnswer({ is_admin: false, group_ids: [GROUP_1], effective_keys: [`g:${GROUP_1}`, 'all'] }),
    );
    const b = await resolve(
      scope,
      { kind: 'user', userId: USER_B },
      resolverAnswer({ is_admin: false, group_ids: [GROUP_1, GROUP_2], effective_keys: ['all', `g:${GROUP_1}`] }),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.scope.access?.setHash).toBe(b.scope.access?.setHash);
  });

  test('an effective key outside the caller keys is ignored, so the hash never names a foreign key', async () => {
    const out = await resolve(
      mintScope('single', null, null),
      { kind: 'user', userId: USER_A },
      resolverAnswer({ is_admin: false, group_ids: [], effective_keys: ['all', `g:${GROUP_2}`] }),
    );
    expect(out.ok && out.scope.access?.setHash).toBe(hashAccessKeys(['all']));
  });

  test('an admin gets admin_all with the fixed admin hash', async () => {
    const out = await resolve(
      mintScope('single', null, null),
      { kind: 'user', userId: USER_A },
      resolverAnswer({ is_admin: true, group_ids: [GROUP_1], effective_keys: ['all'] }),
    );
    expect(out.ok && scopeAccessFilter(out.scope)).toEqual({ mode: 'admin_all' });
    if (out.ok) expect(out.scope.access?.setHash).toBe(ACCESS_ADMIN_HASH);
  });

  test('eval with a user resolves like a user; eval without one is anonymous', async () => {
    const withUser = await resolve(
      mintScope('single', null, null),
      { kind: 'eval', userId: USER_A },
      resolverAnswer({ is_admin: false, group_ids: [GROUP_1], effective_keys: ['all'] }),
    );
    expect(calls).toHaveLength(1);
    expect(withUser.ok && scopeAccessFilter(withUser.scope)).toMatchObject({ mode: 'keys', keys: ['all', `g:${GROUP_1}`, `u:${USER_A}`] });
    calls = [];
    const anonymous = await resolve(mintScope('single', null, null), { kind: 'eval', userId: null }, () => ({ data: null, error: null }));
    expect(calls).toEqual([]);
    expect(anonymous.ok && scopeAccessFilter(anonymous.scope)).toMatchObject({ mode: 'keys', keys: ['all'] });
  });

  test('embed with a known group gets all and that group; the hash follows labels_current', async () => {
    const scope = mintScope('org', null, ORG_O);
    const current = await resolve(scope, { kind: 'embed', groupKey: 'team-one' }, () => ({
      data: [{ id: GROUP_1, name: 'Team one', labels_current: true }],
      error: null,
    }));
    expect(calls).toEqual([{ fn: 'rag_access_group_by_key', args: { p_tenant_key: `o:${ORG_O}`, p_key: 'team-one' } }]);
    expect(current.ok && scopeAccessFilter(current.scope)).toEqual({
      mode: 'keys',
      keys: ['all', `g:${GROUP_1}`],
      setHash: hashAccessKeys(['all', `g:${GROUP_1}`]),
    });
    const unlabelled = await resolve(scope, { kind: 'embed', groupKey: 'team-one' }, () => ({
      data: [{ id: GROUP_1, name: 'Team one', labels_current: false }],
      error: null,
    }));
    expect(unlabelled.ok && unlabelled.scope.access?.setHash).toBe(hashAccessKeys(['all']));
  });

  test('embed with an unknown group logs once per process and gets all only', async () => {
    const scope = mintScope('single', null, null);
    for (let i = 0; i < 2; i += 1) {
      const out = await resolve(scope, { kind: 'embed', groupKey: 'missing-key' }, () => ({ data: [], error: null }));
      expect(out.ok && scopeAccessFilter(out.scope)).toEqual({ mode: 'keys', keys: ['all'], setHash: hashAccessKeys(['all']) });
    }
    const lines = warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('embed_group_not_found'));
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('missing-key');
  });

  test('embed with an empty group key makes no call and gets all', async () => {
    const out = await resolve(mintScope('single', null, null), { kind: 'embed', groupKey: '  ' }, () => ({ data: null, error: null }));
    expect(calls).toEqual([]);
    expect(out.ok && scopeAccessFilter(out.scope)).toMatchObject({ mode: 'keys', keys: ['all'] });
  });

  test('every lookup failure is a 503 refusal and never a scope', async () => {
    const scope = mintScope('single', null, null);
    const user: AccessIdentity = { kind: 'user', userId: USER_A };
    const failures = [
      await resolve(scope, user, () => ({ data: null, error: { message: 'boom' } })),
      await resolve(scope, user, () => {
        throw new Error('network');
      }),
      await resolve(scope, user, () => ({ data: [], error: null })),
      await resolve(scope, user, () => ({ data: [{ is_admin: false, group_ids: ['not-a-uuid'], effective_keys: ['all'] }], error: null })),
      await resolve(scope, { kind: 'embed', groupKey: 'team-one' }, () => ({ data: null, error: { message: 'boom' } })),
      await resolve(scope, { kind: 'user', userId: 'not-a-uuid' }, resolverAnswer({ is_admin: false, group_ids: [], effective_keys: ['all'] })),
    ];
    for (const out of failures) {
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.status).toBe(503);
        expect(typeof out.reason).toBe('string');
      }
    }
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('boom');
  });

  test('a null admin client and an aborted signal are refusals', async () => {
    const scope = mintScope('single', null, null);
    const noClient = await resolveAccessScope({
      scope,
      identity: { kind: 'user', userId: USER_A },
      signal: new AbortController().signal,
      admin: null,
      config: ON,
    });
    expect(noClient).toEqual({ ok: false, status: 503, reason: 'access_unavailable' });
    const controller = new AbortController();
    controller.abort();
    const aborted = await resolve(scope, { kind: 'user', userId: USER_A }, resolverAnswer({ is_admin: true, group_ids: [], effective_keys: [] }), ON, controller.signal);
    expect(aborted).toEqual({ ok: false, status: 503, reason: 'access_aborted' });
  });

  test('records the resolution time for the access_scope stage', async () => {
    let t = 1_000;
    setRagDepsForTests({ now: () => (t += 7) });
    const out = await resolve(
      mintScope('single', null, null),
      { kind: 'user', userId: USER_A },
      resolverAnswer({ is_admin: false, group_ids: [], effective_keys: ['all'] }),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(accessScopeTiming(out.scope)).toBe(7);
    expect(accessScopeTiming(mintScope('single', null, null))).toBeNull();
  });
});

describe('bodyNamesAccessGroups', () => {
  test('finds a top-level accessGroups or groups key of a plain object only', () => {
    expect(bodyNamesAccessGroups({ accessGroups: ['g:x'] })).toBe(true);
    expect(bodyNamesAccessGroups({ groups: [] })).toBe(true);
    expect(bodyNamesAccessGroups({ message: 'x', nested: { groups: ['a'] } })).toBe(false);
    expect(bodyNamesAccessGroups({ groups: undefined })).toBe(false);
    expect(bodyNamesAccessGroups([{ groups: 1 }])).toBe(false);
    expect(bodyNamesAccessGroups(null)).toBe(false);
    expect(bodyNamesAccessGroups('groups')).toBe(false);
  });
});

describe('accessTableFilter', () => {
  test('null for off and admin_all, the keys otherwise', () => {
    expect(accessTableFilter({ mode: 'off' })).toBeNull();
    expect(accessTableFilter({ mode: 'admin_all' })).toBeNull();
    expect(accessTableFilter({ mode: 'keys', keys: ['all', `g:${GROUP_1}`], setHash: 'h' })).toEqual(['all', `g:${GROUP_1}`]);
  });
});

describe('uploadAccessKeys', () => {
  async function memberScope(isAdmin: boolean): Promise<TenantScope> {
    const out = await resolve(
      mintScope('single', null, null),
      { kind: 'user', userId: USER_A },
      resolverAnswer({ is_admin: isAdmin, group_ids: [GROUP_1], effective_keys: ['all'] }),
    );
    if (!out.ok) throw new Error('setup');
    return out.scope;
  }

  test('null leaves the label untouched and everyone is all', async () => {
    const scope = await memberScope(false);
    expect(uploadAccessKeys(scope, null)).toEqual({ ok: true, keys: null });
    expect(uploadAccessKeys(scope, { everyone: true })).toEqual({ ok: true, keys: ['all'] });
  });

  test('a member may label only their own groups', async () => {
    const scope = await memberScope(false);
    expect(uploadAccessKeys(scope, { groupIds: [GROUP_1] })).toEqual({ ok: true, keys: [`g:${GROUP_1}`] });
    expect(uploadAccessKeys(scope, { groupIds: [GROUP_1, GROUP_2] })).toEqual({ ok: false, reason: 'group_not_allowed' });
    expect(uploadAccessKeys(scope, { groupIds: [] })).toEqual({ ok: false, reason: 'group_not_allowed' });
    expect(uploadAccessKeys(scope, { groupIds: ['nope'] })).toEqual({ ok: false, reason: 'group_not_allowed' });
  });

  test('an admin may label any group', async () => {
    const scope = await memberScope(true);
    expect(uploadAccessKeys(scope, { groupIds: [GROUP_2, GROUP_1] })).toEqual({ ok: true, keys: [`g:${GROUP_1}`, `g:${GROUP_2}`] });
  });

  test('with access off no group label is allowed', async () => {
    const out = await resolve(mintScope('single', null, null), { kind: 'anonymous' }, () => ({ data: null, error: null }), OFF);
    if (!out.ok) throw new Error('setup');
    expect(uploadAccessKeys(out.scope, { groupIds: [GROUP_1] })).toEqual({ ok: false, reason: 'group_not_allowed' });
  });
});
