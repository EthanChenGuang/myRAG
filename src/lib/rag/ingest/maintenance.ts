import { logger } from '@/lib/logger';
import { alertDeadLettersIfNeeded } from './dead-letter';
import {
  purgeStaleIngestionJobs,
  type LedgerCallOptions,
  type PurgeStaleJobsResult,
} from './ledger';

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 500;

export type { PurgeStaleJobsResult };

export interface RunIngestionMaintenanceOptions extends Partial<LedgerCallOptions> {
  retentionDays?: number;
  batchSize?: number;
}

/** Archives and purges terminal ledger rows older than the retention window. Idempotent and batched. */
export async function runIngestionMaintenance(
  options: RunIngestionMaintenanceOptions = {},
): Promise<PurgeStaleJobsResult> {
  const signal = options.signal ?? new AbortController().signal;
  const ledgerOptions: LedgerCallOptions = { signal, deps: options.deps };

  await alertDeadLettersIfNeeded(ledgerOptions);

  const retentionDays = options.retentionDays ?? Number(process.env.RAG_INGEST_JOB_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const result = await purgeStaleIngestionJobs(retentionDays, batchSize, ledgerOptions);
  if (result.purged > 0) {
    logger.info('RAG Ingest', 'ingestion maintenance purge', {
      archived: result.archived,
      purged: result.purged,
      retention_days: result.retention_days,
    });
  }
  return result;
}