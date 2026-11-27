import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

const tasks = vi.hoisted(() => [] as Array<() => Promise<void>>);
const afterMock = vi.hoisted(() => vi.fn((task: () => Promise<void>) => void tasks.push(task)));
const sliceMock = vi.hoisted(() => vi.fn());
const statusMock = vi.hoisted(() => vi.fn());

vi.mock('next/server', () => ({ after: afterMock }));
vi.mock('@/lib/rag/sync/slice', () => ({ runVectorSyncSlice: sliceMock }));
vi.mock('@/lib/rag/sync/targets', () => ({ readEnabledTargets: statusMock }));

const RPC = { rpc: () => undefined } as unknown as RpcClient;
let clock = 1_000_000;

async function load() {
  vi.resetModules();
  const mod = await import('@/lib/rag/sync/kick');
  mod.resetVectorSyncKickForTests();
  return mod;
}

async function flush(): Promise<void> {
  while (tasks.length) await tasks.shift()!();
}

const deps = () => ({ now: () => clock, rpc: () => RPC });

beforeEach(() => {
  tasks.length = 0;
  clock = 1_000_000;
  afterMock.mockClear();
  afterMock.mockImplementation((task: () => Promise<void>) => void tasks.push(task));
  sliceMock.mockReset();
  sliceMock.mockResolvedValue({});
  statusMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('kickVectorSync', () => {
  test('with no enabled target nothing drains and the targets read is cached for 30 s', async () => {
    statusMock.mockResolvedValue([]);
    const { kickVectorSync } = await load();
    kickVectorSync(deps());
    await flush();
    for (let i = 0; i < 5; i += 1) {
      clock += 5_000;
      kickVectorSync(deps());
      await flush();
    }
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(sliceMock).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);
    clock += 6_000;
    kickVectorSync(deps());
    await flush();
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(sliceMock).not.toHaveBeenCalled();
  });

  test('with a target enabled, after() receives one callback that runs one drain slice of 10 s', async () => {
    statusMock.mockResolvedValue(['qdrant']);
    const { kickVectorSync } = await load();
    kickVectorSync(deps());
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(sliceMock).not.toHaveBeenCalled();
    await flush();
    expect(sliceMock).toHaveBeenCalledTimes(1);
    expect(sliceMock.mock.calls[0][0]).toBe('drain');
    expect(sliceMock.mock.calls[0][1]).toMatchObject({ rpc: RPC, budgetMs: 10_000, targets: ['qdrant'] });
  });

  test('a second kick while one is scheduled adds no second slice', async () => {
    statusMock.mockResolvedValue(['qdrant']);
    const { kickVectorSync } = await load();
    kickVectorSync(deps());
    kickVectorSync(deps());
    await flush();
    expect(sliceMock).toHaveBeenCalledTimes(1);
  });

  test('outside a request scope (after() throws) it is a no-op', async () => {
    afterMock.mockImplementation(() => {
      throw new Error('after() was called outside a request scope');
    });
    statusMock.mockResolvedValue(['qdrant']);
    const { kickVectorSync } = await load();
    expect(() => kickVectorSync(deps())).not.toThrow();
    expect(statusMock).not.toHaveBeenCalled();
    expect(sliceMock).not.toHaveBeenCalled();
    afterMock.mockImplementation((task: () => Promise<void>) => void tasks.push(task));
    statusMock.mockResolvedValue(['qdrant']);
    kickVectorSync(deps());
    await flush();
    expect(sliceMock).toHaveBeenCalledTimes(1);
  });

  test('a drain error is swallowed with one [Vector Sync] kick failed warning carrying the code only', async () => {
    statusMock.mockResolvedValue(['qdrant']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { kickVectorSync } = await load();
    const { RetrievalBackendError } = await import('@/lib/rag/backend/supabase-rpc');
    sliceMock.mockRejectedValue(new RetrievalBackendError('rag_vector_sync_claim', 'PGRST301'));
    kickVectorSync(deps());
    await expect(flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['[Vector Sync] kick failed', { code: 'rag_vector_sync_claim:pgrst301' }]);
  });

  test('a plain error logs its class, never its message', async () => {
    statusMock.mockRejectedValue(new TypeError('fetch failed https://host.example?apikey=placeholder'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { kickVectorSync } = await load();
    kickVectorSync(deps());
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['[Vector Sync] kick failed', { code: 'TypeError' }]);
  });

  test('no admin client means nothing runs', async () => {
    statusMock.mockResolvedValue(['qdrant']);
    const { kickVectorSync } = await load();
    kickVectorSync({ now: () => clock, rpc: () => null });
    await flush();
    expect(statusMock).not.toHaveBeenCalled();
    expect(sliceMock).not.toHaveBeenCalled();
  });

  test('kickVectorSync returns before any read or drain (never delays the response)', async () => {
    let resolveStatus: (value: string[]) => void = () => undefined;
    statusMock.mockReturnValue(new Promise<string[]>((resolve) => (resolveStatus = resolve)));
    const { kickVectorSync } = await load();
    expect(kickVectorSync(deps())).toBeUndefined();
    expect(statusMock).not.toHaveBeenCalled();
    const pending = flush();
    resolveStatus(['qdrant']);
    await pending;
    expect(sliceMock).toHaveBeenCalledTimes(1);
  });
});
