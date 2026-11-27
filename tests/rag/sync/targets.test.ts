import { describe, expect, test, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { createFakeVectorStore } from '@/lib/rag/sync/stores/fake';
import { buildVectorSyncStores, readEnabledTargets, readVectorSyncStatus } from '@/lib/rag/sync/targets';

function stubRpc(data: unknown, error: { code: string } | null = null): RpcClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rpc(fn: string) {
      calls.push(fn);
      return { abortSignal: async () => ({ data, error }) };
    },
  } as unknown as RpcClient & { calls: string[] };
}

describe('vector sync targets', () => {
  test('readVectorSyncStatus parses the 0708 rows and drops unknown targets', async () => {
    const rpc = stubRpc([
      { target: 'qdrant', enabled: true, pending: '3', leased: 1, dead: 0, oldest_pending_seconds: 42 },
      { target: 'weaviate', enabled: false, pending: 0, leased: 0, dead: 2, oldest_pending_seconds: null },
      { target: 'other', enabled: true, pending: 9, leased: 0, dead: 0, oldest_pending_seconds: 1 },
    ]);
    expect(await readVectorSyncStatus(rpc)).toEqual([
      { target: 'qdrant', enabled: true, pending: 3, leased: 1, dead: 0, oldestPendingSeconds: 42 },
      { target: 'weaviate', enabled: false, pending: 0, leased: 0, dead: 2, oldestPendingSeconds: null },
    ]);
    expect(rpc.calls).toEqual(['rag_vector_sync_status']);
    expect(await readEnabledTargets(rpc)).toEqual(['qdrant']);
  });

  test('a status error is raised as a backend error code', async () => {
    await expect(readVectorSyncStatus(stubRpc(null, { code: '42883' }))).rejects.toThrow(/rag_vector_sync_status/);
  });

  test('a target whose client cannot be built is left out with one warning naming the target only', async () => {
    const warn = vi.fn();
    const qdrant = createFakeVectorStore('qdrant');
    const stores = await buildVectorSyncStores(
      ['weaviate', 'qdrant'],
      {
        weaviate: async () => {
          throw new TypeError('WEAVIATE_URL is not set: https://secret.example');
        },
        qdrant: async () => qdrant,
      },
      warn,
    );
    expect(stores).toEqual([qdrant]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(['[Vector Sync] store unavailable', { target: 'weaviate', error: 'TypeError' }]);
  });
});
