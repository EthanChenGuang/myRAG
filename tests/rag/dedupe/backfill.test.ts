import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';

const cluster = vi.hoisted(() => ({
  listChunkText: vi.fn(),
  clusterChunksForTenantKey: vi.fn(),
  recomputeForTenantKey: vi.fn(),
}));

vi.mock('@/lib/rag/dedupe/cluster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/dedupe/cluster')>();
  return { ...actual, ...cluster };
});

const { runDupBackfill } = await import('@/lib/rag/dedupe/backfill');

const TENANT = 's:default';
const db = { rpc: vi.fn() } as unknown as RpcClient;
const PAGE = [{ id: '00000000-0000-4000-8000-0000000000e1', documentId: '00000000-0000-4000-8000-0000000000d1', content: 'alpha' }];

beforeEach(() => {
  cluster.listChunkText.mockReset().mockResolvedValueOnce(PAGE).mockResolvedValue([]);
  cluster.clusterChunksForTenantKey.mockReset().mockResolvedValue({ hashed: 1, clustered: 0, clusters: 0 });
  cluster.recomputeForTenantKey.mockReset().mockResolvedValue({ recomputed: 0, dissolved: 0 });
});

describe('runDupBackfill threshold source (D-49)', () => {
  test('the operator backfill clusters without evalRun, so a fixture threshold entry never applies', async () => {
    await runDupBackfill({ db, tenantKey: TENANT });
    const options = cluster.clusterChunksForTenantKey.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.evalRun).toBeUndefined();
    expect(Object.keys(options).sort()).toEqual(['db', 'signal']);
  });

  test('the eval harness passes evalRun through to clustering', async () => {
    await runDupBackfill({ db, tenantKey: TENANT, evalRun: true });
    const options = cluster.clusterChunksForTenantKey.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options.evalRun).toBe(true);
  });
});
