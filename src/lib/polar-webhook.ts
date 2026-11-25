import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60;

export interface PolarWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

function signingKey(secret: string): Buffer | null {
  if (secret.startsWith('whsec_')) {
    const decoded = Buffer.from(secret.slice('whsec_'.length), 'base64');
    return decoded.length > 0 ? decoded : null;
  }
  return Buffer.from(secret, 'utf8');
}

/** Standard Webhooks verification. Fails closed on a missing secret, header, stale timestamp or mismatch. */
export function verifyPolarWebhookSignature(
  payload: string,
  headers: PolarWebhookHeaders,
  webhookSecret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!webhookSecret || !headers.id || !headers.timestamp || !headers.signature) return false;
  if (!/^\d{1,12}$/.test(headers.timestamp)) return false;
  const timestamp = Number(headers.timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > TOLERANCE_SECONDS) return false;

  const key = signingKey(webhookSecret);
  if (!key) return false;
  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${payload}`)
    .digest();

  for (const candidate of headers.signature.split(' ')) {
    const separator = candidate.indexOf(',');
    if (separator === -1 || candidate.slice(0, separator) !== 'v1') continue;
    const given = Buffer.from(candidate.slice(separator + 1), 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

// A message signed at t is accepted from t-5min to t+5min, so its id must stay recorded for two tolerance windows.
const REPLAY_TTL_MS = TOLERANCE_SECONDS * 2 * 1000;
const MAX_TRACKED_IDS = 10_000;
const seenIds = new Map<string, number>();

/** Records a verified webhook-id. Returns false when the same id was already accepted inside the replay window (per process). */
export function claimPolarWebhookId(id: string, nowMs: number = Date.now()): boolean {
  for (const [stored, expiresAt] of seenIds) {
    if (expiresAt > nowMs) break;
    seenIds.delete(stored);
  }
  if (seenIds.has(id)) return false;
  while (seenIds.size >= MAX_TRACKED_IDS) {
    const oldest = seenIds.keys().next().value;
    if (oldest === undefined) break;
    seenIds.delete(oldest);
  }
  seenIds.set(id, nowMs + REPLAY_TTL_MS);
  return true;
}

/** Frees an id after a failed delivery so the provider's retry of the same message is processed. */
export function releasePolarWebhookId(id: string): void {
  seenIds.delete(id);
}
