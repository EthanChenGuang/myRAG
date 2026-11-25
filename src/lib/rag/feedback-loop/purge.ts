import type { SupabaseClient } from '@supabase/supabase-js';

export const PURGE_BATCH_SIZE = 1000;
/** 10 000 batches of 1000 rows: far above any real backlog, low enough that a misbehaving function cannot loop forever. */
export const MAX_PURGE_BATCHES = 10_000;

export interface PurgeCounts {
  logRows: number;
  reviewItems: number;
}

export interface PurgeOptions {
  now?: () => number;
  maxBatches?: number;
}

const ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;

/** Carries a code only; database messages never reach the caller's output. */
export class PurgeError extends Error {
  constructor(readonly code: string) {
    super(`[Feedback Loop] purge failed (${code})`);
    this.name = 'PurgeError';
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  }
  return 'database_error';
}

interface RpcResponse {
  data: unknown;
  error: unknown;
}

interface DeleteResponse {
  error: unknown;
  count?: number | null;
}

/**
 * D-06, D-15: deletes retrieval log rows older than the retention window through rag_purge_retrieval_log (service role, batches of 1000
 * by ctid, repeated until a batch comes back short), then the open review items whose expires_at has passed. Labelled items stay until
 * exported. Returns counts only.
 */
export async function purgeRetrievalLog(client: SupabaseClient, retentionDays: number, options: PurgeOptions = {}): Promise<PurgeCounts> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new PurgeError('invalid_retention_days');
  const maxBatches = options.maxBatches ?? MAX_PURGE_BATCHES;

  let logRows = 0;
  for (let batch = 0; ; batch += 1) {
    if (batch >= maxBatches) throw new PurgeError('batch_limit');
    const { data, error } = (await client.rpc('rag_purge_retrieval_log', {
      p_retention_days: retentionDays,
      p_batch_size: PURGE_BATCH_SIZE,
    })) as unknown as RpcResponse;
    if (error) throw new PurgeError(errorCode(error));
    const deleted = typeof data === 'number' && Number.isInteger(data) && data >= 0 ? data : NaN;
    if (Number.isNaN(deleted)) throw new PurgeError('unexpected_result');
    logRows += deleted;
    if (deleted < PURGE_BATCH_SIZE) break;
  }

  const now = new Date((options.now ?? Date.now)()).toISOString();
  const { error, count } = (await client
    .from('rag_review_items')
    .delete({ count: 'exact' })
    .eq('status', 'open')
    .lt('expires_at', now)) as unknown as DeleteResponse;
  if (error) throw new PurgeError(errorCode(error));

  return { logRows, reviewItems: typeof count === 'number' ? count : 0 };
}
