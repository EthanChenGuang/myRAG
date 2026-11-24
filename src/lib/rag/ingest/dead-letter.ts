import { logger } from '@/lib/logger';
import type { RpcClient } from '../backend/supabase-rpc';
import { IngestLedgerError } from './ledger';
import { getIngestDeps } from './deps';

export async function countIngestionDeadLetters(
  options: { tenantKey?: string | null; signal?: AbortSignal; db?: () => RpcClient | null } = {},
): Promise<number> {
  const client = (options.db ?? getIngestDeps().db)();
  if (!client) throw new IngestLedgerError('rag_count_ingestion_dead_letters', 'no_db');

  let request = client.rpc('rag_count_ingestion_dead_letters', {
    p_tenant_key: options.tenantKey ?? null,
  });
  if (options.signal) request = request.abortSignal(options.signal);
  const response = await request;
  options.signal?.throwIfAborted();
  if (response.error) throw new IngestLedgerError('rag_count_ingestion_dead_letters', response.error.code ?? null);
  const value = response.data;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '') return Number(value);
  if (Array.isArray(value) && value[0] != null) return Number(value[0]);
  return Number(value ?? 0);
}

/** Emits a structured WARN when dead-letter jobs exist (observability hook, no new vendors). */
export function emitDeadLetterAlert(count: number, scope: 'deployment' | 'tenant' = 'deployment'): void {
  if (count < 1) return;
  logger.warn('RAG Ingest', 'ingestion dead letters present', { count, scope, signal: 'ingestion_dead_letters' });
}