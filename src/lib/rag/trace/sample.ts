import { createHash } from 'node:crypto';

export type SamplePrefix = 'trace' | 'review';

/** Deterministic sampling: the first 8 hex chars of sha256(prefix:requestId) as a fraction of 2^32 against the rate. */
export function isSampled(requestId: string, rate: number, prefix: SamplePrefix = 'trace'): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  const digest = createHash('sha256').update(`${prefix}:${requestId}`).digest('hex');
  return parseInt(digest.slice(0, 8), 16) / 2 ** 32 < rate;
}
