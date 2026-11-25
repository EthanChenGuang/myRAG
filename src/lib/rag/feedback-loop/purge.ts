import type { SupabaseClient } from '@supabase/supabase-js';

export const PURGE_BATCH_SIZE = 1000;

export class PurgeError extends Error {
  constructor(readonly code: string) {
    super(`[Feedback Loop] purge failed (${code})`);
    this.name = 'PurgeError';
  }
}

export async function purgeRetrievalLog(
  _client: SupabaseClient,
  _retentionDays: number,
  _options: { now?: () => number; maxBatches?: number } = {},
): Promise<{ logRows: number; reviewItems: number }> {
  return { logRows: 0, reviewItems: 0 };
}
