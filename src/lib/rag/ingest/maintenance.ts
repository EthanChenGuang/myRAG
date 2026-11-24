import { logger } from '@/lib/logger';
import { countIngestionDeadLetters, emitDeadLetterAlert } from './dead-letter';
import type { RpcClient } from '../backend/supabase-rpc';
import { IngestLedgerError } from './ledger';
import { getIngestDeps } from './deps';

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 500;

export interface PurgeStaleJobsResult {
  archived: number;
  purged: number;
  retention_days: number;
}

function parsePurgeResult(data: unknown): PurgeStaleJobsResult {
  if (!data || typeof data !== 'object') throw new IngestLedgerError('rag_purge_stale_ingestion_jobs', 'invalid_row');
  const row = data as Record<string, unknown>;
  return {
    archived: Number(row.archived ?? 0),
    purged: Number(row.purged ?? 0),
    retention_days: Number(row.retention_days ?? DEFAULT_RETENTION_DAYS),
  };
}

export interface RunIngestionMaintenanceOptions {
  retentionDays?: number;
  batchSize?: number;
  signal?: AbortSignal;
  db?: () => RpcClient | null;
}

/** Archives and purges terminal ledger rows older than the retention window. Idempotent and batched. */
export async function runIngestionMaintenance(
  options: RunIngestionMaintenanceOptions = {},
): Promise<PurgeStaleJobsResult> {
  const db = options.db ?? getIngestDeps().db;
  const client = db();
  if (!client) throw new IngestLedgerError('rag_purge_stale_ingestion_jobs', 'no_db');
  const signal = options.signal;

  const deadLetters = await countIngestionDeadLetters({ signal, db });
  emitDeadLetterAlert(deadLetters);

  const retentionDays = options.retentionDays ?? Number(process.env.RAG_INGEST_JOB_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  let request = client.rpc('rag_purge_stale_ingestion_jobs', {
    p_retention_days: retentionDays,
    p_batch_size: batchSize,
  });
  if (signal) request = request.abortSignal(signal);

  const response = await request;
  signal?.throwIfAborted();
  if (response.error) throw new IngestLedgerError('rag_purge_stale_ingestion_jobs', response.error.code ?? null);

  const result = parsePurgeResult(response.data);
  if (result.purged > 0) {
    logger.info('RAG Ingest', 'ingestion maintenance purge', {
      archived: result.archived,
      purged: result.purged,
      retention_days: result.retention_days,
    });
  }
  return result;
}