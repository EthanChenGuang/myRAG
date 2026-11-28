import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStaleRepairForTests, scheduleStaleRepair, STALE_REPAIR_INTERVAL_MS, type StaleRepairDeps } from '@/lib/rag/backend/stale-repair';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);

function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

interface Harness {
  deps: StaleRepairDeps;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
  tasks: Array<() => Promise<void>>;
  kicks: number;
  warnings: Array<{ line: string; data: Record<string, string | number> }>;
  clock: { at: number };
  flush(): Promise<void>;
}

function harness(answer: RpcResponse = { data: 1, error: null }): Harness {
  const h: Harness = {
    calls: [],
    tasks: [],
    kicks: 0,
    warnings: [],
    clock: { at: 1_000_000 },
    deps: {},
    async flush() {
      const pending = h.tasks.splice(0);
      for (const task of pending) await task();
    },
  };
  const client: RpcClient = {
    rpc(fn, args) {
      h.calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      const req: RpcRequest = { abortSignal: () => req, then: (ok, bad) => Promise.resolve(answer).then(ok, bad) };
      return req;
    },
  };
  h.deps = {
    rpc: () => client,
    schedule: (task) => {
      h.tasks.push(task);
    },
    now: () => h.clock.at,
    kick: () => {
      h.kicks += 1;
    },
    warn: (line, data) => {
      h.warnings.push({ line, data });
    },
  };
  return h;
}

beforeEach(() => resetStaleRepairForTests());
afterEach(() => {
  resetStaleRepairForTests();
  vi.restoreAllMocks();
});

describe('scheduleStaleRepair (RET-05, D-11)', () => {
  it('sends the first 200 distinct ids for the caller tenant after the response, then kicks one drain slice', async () => {
    const h = harness();
    const ids = Array.from({ length: 350 }, (_, i) => id(i % 300));
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: ids }, h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.tasks).toHaveLength(1);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call!.fn).toBe('rag_vector_sync_enqueue_stale');
    expect(call!.args.p_target).toBe('qdrant');
    expect(call!.args.p_tenant_key).toBe(`u:${USER_A}`);
    const sent = call!.args.p_chunk_ids as string[];
    expect(sent).toHaveLength(200);
    expect(new Set(sent).size).toBe(200);
    expect(sent).toEqual(Array.from({ length: 200 }, (_, i) => id(i)));
    expect(h.kicks).toBe(1);
    expect(h.warnings).toEqual([]);
  });

  it('rate: a second call for the same target and tenant within 60 s sends nothing; after the window it sends again', async () => {
    const h = harness();
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [id(1)] }, h.deps);
    h.clock.at += STALE_REPAIR_INTERVAL_MS - 1;
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [id(2)] }, h.deps);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    h.clock.at += 1;
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [id(3)] }, h.deps);
    await h.flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.args.p_chunk_ids).toEqual([id(3)]);
  });

  it('rate: another tenant and another target are not limited by the first', async () => {
    const h = harness();
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [id(1)] }, h.deps);
    scheduleStaleRepair({ target: 'qdrant', scope: scopeB, chunkIds: [id(2)] }, h.deps);
    scheduleStaleRepair({ target: 'weaviate', scope: scopeA, chunkIds: [id(3)] }, h.deps);
    await h.flush();
    expect(h.calls.map((call) => [call.args.p_target, call.args.p_tenant_key])).toEqual([
      ['qdrant', `u:${USER_A}`],
      ['qdrant', `u:${USER_B}`],
      ['weaviate', `u:${USER_A}`],
    ]);
  });

  it('does nothing outside a request scope and keeps no rate entry', async () => {
    const h = harness();
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [id(1)] }, { ...h.deps, schedule: undefined });
    expect(h.calls).toHaveLength(0);
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [id(1)] }, h.deps);
    await h.flush();
    expect(h.calls).toHaveLength(1);
  });

  it('no ids or only malformed ids: nothing is scheduled', () => {
    const h = harness();
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: [] }, h.deps);
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: ['not-an-id', ''] }, h.deps);
    expect(h.tasks).toHaveLength(0);
  });

  it('an RPC error gives one [Vector Sync] warning with counts only, no id or key, and no kick', async () => {
    const h = harness({ data: null, error: { code: '22023', message: 'vector_sync_refused: tenant_mismatch' } });
    const ids = [id(7), id(8)];
    scheduleStaleRepair({ target: 'qdrant', scope: scopeA, chunkIds: ids }, h.deps);
    await expect(h.flush()).resolves.toBeUndefined();
    expect(h.kicks).toBe(0);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]!.line).toBe('[Vector Sync] stale repair failed');
    expect(h.warnings[0]!.data).toEqual({ code: 'rag_vector_sync_enqueue_stale:22023', requested: 2 });
    const serialized = JSON.stringify(h.warnings);
    for (const secret of [...ids, USER_A]) expect(serialized).not.toContain(secret);
  });

  it('a thrown client error is swallowed the same way', async () => {
    const h = harness();
    scheduleStaleRepair(
      { target: 'weaviate', scope: scopeA, chunkIds: [id(9)] },
      {
        ...h.deps,
        rpc: () => {
          throw new TypeError('boom');
        },
      },
    );
    await expect(h.flush()).resolves.toBeUndefined();
    expect(h.warnings).toEqual([{ line: '[Vector Sync] stale repair failed', data: { code: 'TypeError', requested: 1 } }]);
  });
});
