import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countIngestionDeadLetters, emitDeadLetterAlert } from '@/lib/rag/ingest/dead-letter';
import { setIngestDepsForTests, resetIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { logger } from '@/lib/logger';

describe('dead letter alerting', () => {
  beforeEach(() => {
    resetIngestDepsForTests();
  });

  afterEach(() => {
    resetIngestDepsForTests();
    vi.restoreAllMocks();
  });

  it('counts dead letters through RPC', async () => {
    const payload = { data: 3, error: null };
    const rpc = vi.fn(() => ({
      abortSignal: () => payload,
      then: (resolve: (value: unknown) => void) => resolve(payload),
    }));
    setIngestDepsForTests({ db: () => ({ rpc }) as never });
    await expect(countIngestionDeadLetters()).resolves.toBe(3);
  });

  it('warns only when count is positive', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    emitDeadLetterAlert(0);
    emitDeadLetterAlert(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[2]).toMatchObject({ count: 2, signal: 'ingestion_dead_letters' });
  });
});