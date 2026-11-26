import crypto from 'node:crypto';
import { MIN_EMBED_FEEDBACK_SECRET_LENGTH, readFeedbackLoopConfig } from './config';

export const EMBED_FEEDBACK_AUDIENCE = 'embed-feedback';
const TOKEN_VERSION = 1;
const TTL_SECONDS = 24 * 3600;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 4096;
const TRACE_ID = /^[0-9a-f]{32}$/;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface EmbedFeedbackTokenClaims {
  traceId: string;
  tenantKey: string;
}

export interface EmbedFeedbackTokenOptions {
  /** Defaults to RAG_EMBED_FEEDBACK_SECRET, which readFeedbackLoopConfig exposes only while the embed rating is enabled. */
  secret?: string | null;
  /** Epoch milliseconds; defaults to the current time. */
  now?: number;
}

interface EmbedFeedbackPayload {
  v: 1;
  aud: typeof EMBED_FEEDBACK_AUDIENCE;
  tid: string;
  tk: string;
  iat: number;
  exp: number;
}

function resolveSecret(options: EmbedFeedbackTokenOptions): string | null {
  const secret = options.secret !== undefined ? options.secret : readFeedbackLoopConfig().embedFeedbackSecret;
  return typeof secret === 'string' && secret.length >= MIN_EMBED_FEEDBACK_SECRET_LENGTH ? secret : null;
}

function hmac(secret: string, payloadB64: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64, 'utf8').digest('base64url');
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/** D-11: binds one embed vote to one retrieval trace of one tenant for 24 h. Returns null when the secret is unusable or an input is malformed. */
export function mintEmbedFeedbackToken(input: EmbedFeedbackTokenClaims, options: EmbedFeedbackTokenOptions = {}): string | null {
  const secret = resolveSecret(options);
  if (!secret) return null;
  if (!TRACE_ID.test(input.traceId) || !TENANT_KEY.test(input.tenantKey)) return null;
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const payload: EmbedFeedbackPayload = {
    v: TOKEN_VERSION,
    aud: EMBED_FEEDBACK_AUDIENCE,
    tid: input.traceId,
    tk: input.tenantKey,
    iat,
    exp: iat + TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${hmac(secret, payloadB64)}`;
}

/** Returns the bound trace and tenant, or null for every failure; callers must not tell the client which check failed. */
export function verifyEmbedFeedbackToken(token: unknown, options: EmbedFeedbackTokenOptions = {}): EmbedFeedbackTokenClaims | null {
  const secret = resolveSecret(options);
  if (!secret) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  const [payloadB64, signature] = parts;
  if (!crypto.timingSafeEqual(sha256(signature), sha256(hmac(secret, payloadB64)))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const claims = parsed as Record<string, unknown>;
  if (claims.v !== TOKEN_VERSION || claims.aud !== EMBED_FEEDBACK_AUDIENCE) return null;
  if (typeof claims.tid !== 'string' || !TRACE_ID.test(claims.tid)) return null;
  if (typeof claims.tk !== 'string' || !TENANT_KEY.test(claims.tk)) return null;
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return null;

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if ((claims.exp as number) + CLOCK_SKEW_SECONDS <= nowSeconds) return null;
  if ((claims.iat as number) > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  return { traceId: claims.tid, tenantKey: claims.tk };
}
