export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 60 * 1000;
const MAX_TRACKED = 10_000;

const seen = new Map<string, number>();

/** The timestamp is inside the HMAC-signed body, so it can only be trusted after the signature check. */
export function isWebhookTimestampFresh(timestamp: unknown, now: number = Date.now()): boolean {
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return false;
  const sentAt = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  return now - sentAt <= WEBHOOK_MAX_AGE_MS && sentAt - now <= WEBHOOK_MAX_FUTURE_SKEW_MS;
}

/** Returns false when this signed body was already accepted inside the replay window. Per process, not shared across instances. */
export function rememberWebhookSignature(signature: string, now: number = Date.now()): boolean {
  const key = signature.toLowerCase();
  for (const [stored, expiresAt] of seen) {
    if (expiresAt > now) break;
    seen.delete(stored);
  }
  if (seen.has(key)) return false;
  while (seen.size >= MAX_TRACKED) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  seen.set(key, now + WEBHOOK_MAX_AGE_MS + WEBHOOK_MAX_FUTURE_SKEW_MS);
  return true;
}
