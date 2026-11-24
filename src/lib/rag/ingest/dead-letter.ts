import { logger } from '@/lib/logger';
import { countDeadLetterJobs, type LedgerCallOptions } from './ledger';

export async function alertDeadLettersIfNeeded(options: LedgerCallOptions, tenantKey?: string | null): Promise<number> {
  const count = await countDeadLetterJobs(tenantKey ?? null, options);
  emitDeadLetterAlert(count, tenantKey ? 'tenant' : 'deployment');
  return count;
}

/** Emits a structured WARN when dead-letter jobs exist (observability hook, no new vendors). */
export function emitDeadLetterAlert(count: number, scope: 'deployment' | 'tenant' = 'deployment'): void {
  if (count < 1) return;
  logger.warn('RAG Ingest', 'ingestion dead letters present', { count, scope, signal: 'ingestion_dead_letters' });
}