import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBackendReady, READINESS_TTL_MS, resetReadinessCacheForTests } from '@/lib/rag/backend/readiness';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER_LOWER = '00000000-0000-4000-8000-0000000000ab';
const PROFILE = 'profile-neutral';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function rpcClient(answer: () => RpcResponse | Promise<RpcResponse>): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve().then(answer).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}

function stateRow(state: string | null, outboxLag: number, lag = 0): RpcResponse {
  return {
    data: [
      {
        target: 'qdrant',
        profile_id: PROFILE,
        tenant_key: 's:default',
        state,
        last_reconciled_at: state ? '2026-01-01T00:00:00Z' : null,
        lag_seconds: state ? lag : null,
        supabase_count: 3,
        backend_count: 3,
        outbox_lag_seconds: outboxLag,
      },
    ],
    error: null,
  };
}

const single = mintScope('single', null, null);
const config = { maxLagSeconds: 300 };

describe('isBackendReady (D-11)', () => {
  beforeEach(() => {
    resetReadinessCacheForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetReadinessCacheForTests();
    vi.restoreAllMocks();
  });

  it('is ready for state ready with a live lag within the maximum', async () => {
    const { client, calls } = rpcClient(() => stateRow('ready', 10));
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: client })).resolves.toBe(true);
    expect(calls).toEqual([
      { fn: 'rag_backend_readiness', args: { p_target: 'qdrant', p_profile_id: PROFILE, p_tenant_key: 's:default' } },
    ]);
  });

  it('is not ready when the live lag passes the maximum', async () => {
    const { client } = rpcClient(() => stateRow('ready', 301));
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: client })).resolves.toBe(false);
  });

  it('is not ready when the reconcile lag passes the maximum even with an empty outbox', async () => {
    const { client } = rpcClient(() => stateRow('ready', 0, 301));
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: client })).resolves.toBe(false);
  });

  it.each(['building', 'stale', 'failed'])('is not ready for state %s', async (state) => {
    const { client } = rpcClient(() => stateRow(state, 0));
    await expect(isBackendReady({ target: 'weaviate', profileId: PROFILE, scope: single, config, rpc: client })).resolves.toBe(false);
  });

  it('is not ready when no index state row exists', async () => {
    const { client } = rpcClient(() => stateRow(null, 0));
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: client })).resolves.toBe(false);
    const empty = rpcClient(() => ({ data: [], error: null }));
    resetReadinessCacheForTests();
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: empty.client })).resolves.toBe(false);
  });

  it('caches the answer for 30 s per target, profile and tenant', async () => {
    let now = 1_000_000;
    const { client, calls } = rpcClient(() => stateRow('ready', 5));
    const ask = () => isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: client, now: () => now });
    await ask();
    now += READINESS_TTL_MS - 1;
    await ask();
    expect(calls).toHaveLength(1);
    now += 2;
    await ask();
    expect(calls).toHaveLength(2);
    await isBackendReady({ target: 'weaviate', profileId: PROFILE, scope: single, config, rpc: client, now: () => now });
    await isBackendReady({ target: 'qdrant', profileId: 'profile-other', scope: single, config, rpc: client, now: () => now });
    expect(calls).toHaveLength(4);
    expect(READINESS_TTL_MS).toBe(30_000);
  });

  it('applies the current maximum lag to a cached row', async () => {
    const { client, calls } = rpcClient(() => stateRow('ready', 120));
    const now = () => 5_000;
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: client, now })).resolves.toBe(true);
    await expect(
      isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config: { maxLagSeconds: 60 }, rpc: client, now }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('is not ready on an RPC error, a rejected call or a missing client, and never throws', async () => {
    const failing = rpcClient(() => ({ data: null, error: { message: 'boom' } }));
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: failing.client })).resolves.toBe(false);
    resetReadinessCacheForTests();
    const rejecting = rpcClient(() => Promise.reject(new Error('network')));
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: rejecting.client })).resolves.toBe(false);
    resetReadinessCacheForTests();
    await expect(isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: null })).resolves.toBe(false);
  });

  it('warns at most once per minute about read failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = 0;
    const failing = rpcClient(() => ({ data: null, error: { message: 'boom' } }));
    for (let index = 0; index < 3; index += 1) {
      resetReadinessCacheForTests({ keepWarnClock: true });
      await isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: failing.client, now: () => now });
      now += 1_000;
    }
    expect(warn).toHaveBeenCalledTimes(1);
    now += 60_000;
    resetReadinessCacheForTests({ keepWarnClock: true });
    await isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: single, config, rpc: failing.client, now: () => now });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[RAG Backend]');
  });

  it('shares one cache entry between an upper-case and a lower-case scope', async () => {
    const { client, calls } = rpcClient(() => stateRow('ready', 1));
    const lower = mintScope('personal', USER_LOWER, null);
    const upper = mintScope('personal', USER_LOWER.toUpperCase(), null);
    await isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: lower, config, rpc: client, now: () => 1 });
    await isBackendReady({ target: 'qdrant', profileId: PROFILE, scope: upper, config, rpc: client, now: () => 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.p_tenant_key).toBe(`u:${USER_LOWER}`);
  });
});
