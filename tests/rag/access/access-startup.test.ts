import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { resetRagDepsForTests } from '@/lib/rag/deps';
import { resolveAccessScope, scopeAccessFilter } from '@/lib/rag/tenant/access';
import {
  getAccessStartupVerdict,
  resetAccessStartupForTests,
  syncAccessEnforcementNow,
  verifyAccessGroupsStartup,
  type AccessStartupDeps,
} from '@/lib/rag/tenant/access-startup';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

type Responder = (call: Call) => RpcResponse | PromiseLike<RpcResponse>;

interface DbState {
  flag: boolean;
  failWrite?: boolean;
  ignoreWrite?: boolean;
  readiness?: RpcResponse;
  drift?: RpcResponse;
}

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

function database(state: DbState, calls: Call[]): RpcClient {
  return fakeClient((call) => {
    if (call.fn === 'rag_access_set_enforced') {
      if (state.failWrite) return { data: null, error: { message: 'permission denied' } };
      if (!state.ignoreWrite) state.flag = call.args.p_enforced as boolean;
      return { data: state.flag, error: null };
    }
    if (call.fn === 'rag_access_enforced') return { data: state.flag, error: null };
    if (call.fn === 'rag_access_readiness') {
      return state.readiness ?? { data: [{ ready: true, reasons: [], objects: [] }], error: null };
    }
    if (call.fn === 'rag_access_groups_drift') return state.drift ?? { data: [], error: null };
    return { data: null, error: { message: 'unexpected' } };
  }, calls);
}

let calls: Call[];
let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;

function deps(state: DbState, over: Partial<AccessStartupDeps> & { mode?: 'on' | 'off' } = {}): Partial<AccessStartupDeps> {
  const { mode = 'on', ...rest } = over;
  return {
    ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: mode }),
    adminClient: () => database(state, calls),
    backendCapabilities: () => ({ accessFilter: true }),
    now: () => 42,
    ...rest,
  };
}

function logged(): string {
  return [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((call) => call.map((arg) => JSON.stringify(arg)).join(' ')).join('\n');
}

beforeEach(() => {
  calls = [];
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  resetAccessStartupForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAccessStartupForTests();
  resetRagDepsForTests();
  resetRagConfigForTests();
});

describe('verifyAccessGroupsStartup', () => {
  test('before any check the verdict is not_checked', () => {
    expect(getAccessStartupVerdict()).toMatchObject({ status: 'not_checked', flagValue: null, reasons: [], objects: [], checkedAt: null });
  });

  test('switch off writes the flag false, reads it back, makes no readiness call and reports off', async () => {
    const state: DbState = { flag: true };
    const verdict = await verifyAccessGroupsStartup(deps(state, { mode: 'off' }));
    expect(state.flag).toBe(false);
    expect(calls.map((c) => c.fn)).toEqual(['rag_access_set_enforced', 'rag_access_enforced']);
    expect(calls[0].args).toEqual({ p_enforced: false });
    expect(verdict).toMatchObject({ status: 'off', flagValue: false, reasons: [], checkedAt: 42 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('switch off with a failed write logs once and still reports off', async () => {
    const state: DbState = { flag: true, failWrite: true };
    const verdict = await verifyAccessGroupsStartup(deps(state, { mode: 'off' }));
    expect(verdict.status).toBe('off');
    expect(verdict.reasons).toContain('flag_write_failed');
    expect(calls.map((c) => c.fn)).not.toContain('rag_access_readiness');
    await syncAccessEnforcementNow(deps(state, { mode: 'off' }));
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('flag_write_failed'))).toHaveLength(1);
    expect(logged()).not.toContain('permission denied');
  });

  test('switch on with everything in place writes true and is ready', async () => {
    const state: DbState = { flag: false };
    const verdict = await verifyAccessGroupsStartup(deps(state));
    expect(state.flag).toBe(true);
    expect(calls[0]).toEqual({ fn: 'rag_access_set_enforced', args: { p_enforced: true } });
    expect(calls.map((c) => c.fn)).toEqual(expect.arrayContaining(['rag_access_enforced', 'rag_access_readiness']));
    expect(verdict).toMatchObject({ status: 'ready', flagValue: true, reasons: [], objects: [] });
  });

  test('switch on: a failed write is not ready', async () => {
    const verdict = await verifyAccessGroupsStartup(deps({ flag: false, failWrite: true }));
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toContain('flag_write_failed');
  });

  test('switch on: a read-back that differs is not ready', async () => {
    const verdict = await verifyAccessGroupsStartup(deps({ flag: false, ignoreWrite: true }));
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toContain('flag_readback_mismatch');
    expect(verdict.flagValue).toBe(false);
  });

  test('switch on: readiness not ok names the reasons and objects', async () => {
    const verdict = await verifyAccessGroupsStartup(
      deps({
        flag: false,
        readiness: {
          data: [{ ready: false, reasons: ['function_overloaded'], objects: ['public.rag_fetch_parents'] }],
          error: null,
        },
      }),
    );
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toEqual(expect.arrayContaining(['readiness_not_ready', 'function_overloaded']));
    expect(verdict.objects).toEqual(['public.rag_fetch_parents']);
  });

  test('switch on: a missing readiness function fails closed', async () => {
    const verdict = await verifyAccessGroupsStartup(
      deps({ flag: false, readiness: { data: null, error: { message: 'function public.rag_access_readiness() does not exist', code: '42883' } } }),
    );
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toContain('readiness_unavailable');
  });

  test('switch on: a backend without accessFilter is not ready', async () => {
    const verdict = await verifyAccessGroupsStartup(deps({ flag: false }, { backendCapabilities: () => ({ versionScope: true }) }));
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toContain('backend_without_access_filter');
  });

  test('switch on without an admin client is not ready', async () => {
    const verdict = await verifyAccessGroupsStartup(deps({ flag: false }, { adminClient: () => null }));
    expect(verdict.status).toBe('not_ready');
    expect(verdict.reasons).toContain('admin_client_missing');
  });

  test('a hanging call times out into not ready instead of blocking startup', async () => {
    const hanging = fakeClient(() => new Promise<RpcResponse>(() => {}), calls);
    const verdict = await verifyAccessGroupsStartup(deps({ flag: false }, { adminClient: () => hanging, timeoutMs: 20 }));
    expect(verdict.status).toBe('not_ready');
  });

  test('never throws, also when a dependency throws', async () => {
    const verdict = await verifyAccessGroupsStartup(
      deps({ flag: false }, {
        backendCapabilities: () => {
          throw new Error('registry exploded');
        },
      }),
    );
    expect(verdict.status).toBe('not_ready');
    expect(logged()).not.toContain('registry exploded');
  });

  test('drift above zero is logged once with store names and counts only', async () => {
    const state: DbState = {
      flag: false,
      drift: { data: [{ store: 'document_chunks', rows: 3 }, { store: 'document_parents', rows: 0 }], error: null },
    };
    await verifyAccessGroupsStartup(deps(state));
    await syncAccessEnforcementNow(deps(state));
    const lines = warnSpy.mock.calls.filter((c) => String(c[0]).startsWith('[RAG Access] drift'));
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ stores: { document_chunks: 3 } });
  });

  test('runs once; syncAccessEnforcementNow reruns and returns the new verdict', async () => {
    const state: DbState = { flag: false, failWrite: true };
    expect((await verifyAccessGroupsStartup(deps(state))).status).toBe('not_ready');
    state.failWrite = false;
    expect((await verifyAccessGroupsStartup(deps(state))).status).toBe('not_ready');
    const synced = await syncAccessEnforcementNow(deps(state));
    expect(synced.status).toBe('ready');
    expect(getAccessStartupVerdict().status).toBe('ready');
  });
});

describe('the resolver gate', () => {
  const resolverClient = (respond: Responder) => fakeClient(respond, calls);
  const answer: Responder = () => ({ data: [{ is_admin: false, group_ids: [], effective_keys: ['all'] }], error: null });

  test('refuses with access_not_ready while the verdict is not ready', async () => {
    await verifyAccessGroupsStartup(deps({ flag: false, failWrite: true }));
    calls = [];
    const out = await resolveAccessScope({
      scope: mintScope('single', null, null),
      identity: { kind: 'user', userId: USER_A },
      signal: new AbortController().signal,
      admin: resolverClient(answer),
      config: { accessGroups: 'on' },
    });
    expect(out).toEqual({ ok: false, status: 503, reason: 'access_not_ready' });
    expect(calls).toEqual([]);
  });

  test('refuses when the startup verdict is off but the request is resolved with the switch on', async () => {
    await verifyAccessGroupsStartup(deps({ flag: true }, { mode: 'off' }));
    const out = await resolveAccessScope({
      scope: mintScope('single', null, null),
      identity: { kind: 'anonymous' },
      signal: new AbortController().signal,
      admin: resolverClient(answer),
      config: { accessGroups: 'on' },
    });
    expect(out).toEqual({ ok: false, status: 503, reason: 'access_not_ready' });
  });

  test('waits for a pending check instead of resolving early', async () => {
    let release: (value: RpcResponse) => void = () => {};
    const gate = new Promise<RpcResponse>((resolve) => {
      release = resolve;
    });
    const state: DbState = { flag: false };
    const slow = fakeClient((call) => (call.fn === 'rag_access_readiness' ? gate : database(state, []).rpc(call.fn, call.args)), []);
    const pending = verifyAccessGroupsStartup(deps(state, { adminClient: () => slow }));
    let settled = false;
    const resolving = resolveAccessScope({
      scope: mintScope('single', null, null),
      identity: { kind: 'anonymous' },
      signal: new AbortController().signal,
      admin: resolverClient(answer),
      config: { accessGroups: 'on' },
    }).then((out) => {
      settled = true;
      return out;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(settled).toBe(false);
    release({ data: [{ ready: true, reasons: [], objects: [] }], error: null });
    await pending;
    const out = await resolving;
    expect(out.ok && scopeAccessFilter(out.scope)).toMatchObject({ mode: 'keys', keys: ['all'] });
  });

  test('with the switch off the gate is never consulted', async () => {
    await verifyAccessGroupsStartup(deps({ flag: false, failWrite: true }));
    const out = await resolveAccessScope({
      scope: mintScope('single', null, null),
      identity: { kind: 'anonymous' },
      signal: new AbortController().signal,
      admin: resolverClient(answer),
      config: { accessGroups: 'off' },
    });
    expect(out.ok && scopeAccessFilter(out.scope)).toEqual({ mode: 'off' });
  });
});
