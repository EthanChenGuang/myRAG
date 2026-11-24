import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIngestDepsForTests, resetIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { runIngestionMaintenance } from '@/lib/rag/ingest/maintenance';

describe('runIngestionMaintenance', () => {
  beforeEach(() => {
    resetIngestDepsForTests();
  });

  afterEach(() => {
    resetIngestDepsForTests();
    vi.unstubAllEnvs();
  });

  it('maps purge RPC counts', async () => {
    const countPayload = { data: 0, error: null };
    const purgePayload = { data: { archived: 2, purged: 2, retention_days: 45 }, error: null };
    const rpc = vi.fn((fn: string) => {
      const payload = fn === 'rag_count_ingestion_dead_letters' ? countPayload : purgePayload;
      return {
        abortSignal: () => payload,
        then: (resolve: (value: unknown) => void) => resolve(payload),
      };
    });
    setIngestDepsForTests({ db: () => ({ rpc }) as never });
    vi.stubEnv('RAG_INGEST_JOB_RETENTION_DAYS', '45');

    const result = await runIngestionMaintenance();
    expect(result).toEqual({ archived: 2, purged: 2, retention_days: 45 });
    expect(rpc).toHaveBeenCalledWith('rag_purge_stale_ingestion_jobs', {
      p_retention_days: 45,
      p_batch_size: 500,
    });
  });
});