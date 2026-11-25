import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';
import { IngestLedgerError } from '../ledger';
import { ParseCacheError } from '../parse-cache';

/** What a callback handler hands the route: a status and a JSON body, so the route stays a thin wrapper. */
export interface CallbackResult<T> {
  status: 200 | 400 | 404 | 409 | 500;
  body: T | { error: string };
}

export function refuse(status: 400 | 404 | 409 | 500, error: string): CallbackResult<never> {
  return { status, body: { error } };
}

export const TERMINAL_JOB_STATUSES: ReadonlySet<IngestionJob['status']> = new Set(['ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate', 'pending_review']);

export function isTerminal(job: IngestionJob): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status);
}

/** The worker must hold a live lease on the job; the ledger functions check the same rule on every write. */
export function leaseHolds(job: IngestionJob, workerId: string, now: number): boolean {
  if (job.locked_by !== workerId || !job.lease_until) return false;
  const until = Date.parse(job.lease_until);
  return Number.isFinite(until) && until > now;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Maps a failure to a response. Only the error name and the stable codes are logged: never document text or keys. */
export function mapError(action: string, error: unknown): CallbackResult<never> {
  if (error instanceof IngestLedgerError) {
    console.error('[RAG Ingest] callback failed', { action, error: error.name, rpc: error.rpc, code: error.code });
    if (error.code === 'lease_lost') return refuse(409, 'lease_lost');
    if (error.code === 'ingest_refused' || error.code === '22023') return refuse(409, 'job_refused');
    return refuse(500, 'ledger_error');
  }
  if (error instanceof ParseCacheError) {
    console.error('[RAG Ingest] callback failed', { action, error: error.name, code: error.code });
    if (error.code === 'document_not_linked') return refuse(409, 'document_not_linked');
    if (error.code === 'no_db' || error.code === 'rpc_failed') return refuse(500, 'cache_error');
    return refuse(404, 'cache_not_found');
  }
  console.error('[RAG Ingest] callback failed', { action, error: errorName(error) });
  return refuse(500, 'callback_failed');
}
