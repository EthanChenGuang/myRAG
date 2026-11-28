import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  LEXSTATS_READY_TTL_MS,
  countReadyLexstatsTenants,
  dropLexstatsReady,
  lexstatsReadiness,
  lexstatsReady,
  resetLexstatsCacheForTests,
} from '@/lib/rag/lexical/stats';

const KEY_A = 'u:00000000-0000-4000-8000-0000000000a1';
const KEY_B = 'u:00000000-0000-4000-8000-0000000000b2';

function statusClient(answer: (key: string) => RpcResponse | Error) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn, args) {
      const request: RpcRequest = {
        abortSignal: () => request,
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          const value = answer(String(args.p_tenant_key));
          const settled = value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

const ready = (chunkCount = 3): RpcResponse => ({ data: { state: 'ready', chunk_count: chunkCount, pending: 0 }, error: null });

beforeEach(() => resetLexstatsCacheForTests());
afterEach(() => resetLexstatsCacheForTests());

describe('lexstatsReady', () => {
  it('reads state ready with a positive chunk count as ready, through rag_lexstats_status with the tenant key', async () => {
    const { client, calls } = statusClient(() => ready());
    await expect(lexstatsReady(client, KEY_A, 1_000)).resolves.toBe(true);
    expect(calls).toEqual([{ fn: 'rag_lexstats_status', args: { p_tenant_key: KEY_A } }]);
  });

  it('also reads the one-row answer keyed by the function name', async () => {
    const { client } = statusClient(() => ({ data: [{ rag_lexstats_status: { state: 'ready', chunk_count: 2 } }], error: null }));
    await expect(lexstatsReady(client, KEY_A, 1_000)).resolves.toBe(true);
  });

  it('reads building, a null state or zero chunks as not ready', async () => {
    for (const data of [{ state: 'building', chunk_count: 3 }, { state: null, chunk_count: 0 }, { state: 'ready', chunk_count: 0 }, null, []]) {
      resetLexstatsCacheForTests();
      const { client } = statusClient(() => ({ data, error: null }));
      await expect(lexstatsReady(client, KEY_A, 1_000)).resolves.toBe(false);
    }
  });

  it('calls the status RPC once per tenant within the TTL and again after it expires', async () => {
    const { client, calls } = statusClient(() => ready());
    await lexstatsReady(client, KEY_A, 1_000);
    await lexstatsReady(client, KEY_A, 1_000 + LEXSTATS_READY_TTL_MS - 1);
    expect(calls).toHaveLength(1);
    await lexstatsReady(client, KEY_A, 1_000 + LEXSTATS_READY_TTL_MS);
    expect(calls).toHaveLength(2);
    expect(LEXSTATS_READY_TTL_MS).toBe(60_000);
  });

  it('keys the cache by tenant key: one tenant ready never makes another ready', async () => {
    const { client, calls } = statusClient((key) => (key === KEY_A ? ready() : { data: { state: null, chunk_count: null }, error: null }));
    await expect(lexstatsReady(client, KEY_A, 1_000)).resolves.toBe(true);
    await expect(lexstatsReady(client, KEY_B, 1_000)).resolves.toBe(false);
    await expect(lexstatsReady(client, KEY_A, 1_001)).resolves.toBe(true);
    await expect(lexstatsReady(client, KEY_B, 1_001)).resolves.toBe(false);
    expect(calls.map((call) => call.args.p_tenant_key)).toEqual([KEY_A, KEY_B]);
  });

  it('never throws: an RPC error, a missing function or a rejected call reads as not ready and is cached', async () => {
    const answers: Array<RpcResponse | Error> = [
      { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } },
      { data: null, error: { message: 'function does not exist', code: '42883' } },
      new Error('network down'),
    ];
    for (const answer of answers) {
      resetLexstatsCacheForTests();
      const { client, calls } = statusClient(() => answer);
      await expect(lexstatsReady(client, KEY_A, 1_000)).resolves.toBe(false);
      await expect(lexstatsReady(client, KEY_A, 2_000)).resolves.toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  it('dropLexstatsReady forgets one tenant so the next request reads the status again', async () => {
    const { client, calls } = statusClient(() => ready());
    await lexstatsReady(client, KEY_A, 1_000);
    await lexstatsReady(client, KEY_B, 1_000);
    dropLexstatsReady(KEY_A);
    await lexstatsReady(client, KEY_A, 1_001);
    await lexstatsReady(client, KEY_B, 1_001);
    expect(calls.map((call) => call.args.p_tenant_key)).toEqual([KEY_A, KEY_B, KEY_A]);
  });

  it('holds at most 1000 tenants and evicts the oldest entry', async () => {
    const { client, calls } = statusClient(() => ready());
    for (let index = 0; index < 1001; index += 1) await lexstatsReady(client, `u:tenant-${index}`, 1_000);
    expect(calls).toHaveLength(1001);
    await lexstatsReady(client, 'u:tenant-1000', 1_001);
    expect(calls).toHaveLength(1001);
    await lexstatsReady(client, 'u:tenant-0', 1_001);
    expect(calls).toHaveLength(1002);
  });
});

describe('countReadyLexstatsTenants', () => {
  function countClient(result: { count: number | null; error: { code?: string } | null } | Error) {
    const seen: Array<{ table: string; columns: string; options: unknown; eq: [string, unknown] | null }> = [];
    const client = {
      from(table: string) {
        return {
          select(columns: string, options: unknown) {
            const entry = { table, columns, options, eq: null as [string, unknown] | null };
            seen.push(entry);
            return {
              eq(column: string, value: unknown) {
                entry.eq = [column, value];
                return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
              },
            };
          },
        };
      },
    };
    return { client, seen };
  }

  it('counts ready state rows with a head-only exact count', async () => {
    const { client, seen } = countClient({ count: 4, error: null });
    await expect(countReadyLexstatsTenants(client as never)).resolves.toBe(4);
    expect(seen).toEqual([{ table: 'rag_lexical_stats_state', columns: 'tenant_key', options: { count: 'exact', head: true }, eq: ['status', 'ready'] }]);
  });

  it('returns null on an error or a rejected call', async () => {
    await expect(countReadyLexstatsTenants(countClient({ count: null, error: { code: '42P01' } }).client as never)).resolves.toBeNull();
    await expect(countReadyLexstatsTenants(countClient(new Error('down')).client as never)).resolves.toBeNull();
  });
});

describe('lexstatsReadiness (04.4-17, D-49)', () => {
  it('reads cluster readiness from the same status answer: ready only with cluster_status ready and ready raw statistics', async () => {
    const cases: Array<[Record<string, unknown> | null, { ready: boolean; clusterReady: boolean }]> = [
      [{ state: 'ready', chunk_count: 3, cluster_status: 'ready' }, { ready: true, clusterReady: true }],
      [{ state: 'ready', chunk_count: 3, cluster_status: 'building' }, { ready: true, clusterReady: false }],
      [{ state: 'ready', chunk_count: 3 }, { ready: true, clusterReady: false }],
      [{ state: 'building', chunk_count: 3, cluster_status: 'ready' }, { ready: false, clusterReady: false }],
      [null, { ready: false, clusterReady: false }],
    ];
    for (const [data, want] of cases) {
      resetLexstatsCacheForTests();
      const { client, calls } = statusClient(() => ({ data, error: null }));
      await expect(lexstatsReadiness(client, KEY_A, 1_000)).resolves.toEqual(want);
      await expect(lexstatsReady(client, KEY_A, 1_001)).resolves.toBe(want.ready);
      expect(calls).toHaveLength(1);
    }
  });

  it('dropLexstatsReady forgets both answers', async () => {
    let cluster = 'ready';
    const { client, calls } = statusClient(() => ({ data: { state: 'ready', chunk_count: 3, cluster_status: cluster }, error: null }));
    await expect(lexstatsReadiness(client, KEY_A, 1_000)).resolves.toEqual({ ready: true, clusterReady: true });
    cluster = 'building';
    dropLexstatsReady(KEY_A);
    await expect(lexstatsReadiness(client, KEY_A, 1_001)).resolves.toEqual({ ready: true, clusterReady: false });
    expect(calls).toHaveLength(2);
  });
});
