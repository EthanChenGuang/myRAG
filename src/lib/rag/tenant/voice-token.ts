import crypto from 'node:crypto';
import { env } from '@/lib/env';
import { scopeKey, type TenantScope } from './scope';

export const VOICE_TOKEN_AUDIENCE = 'voice-rag';
export const MIN_VOICE_SECRET_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 4096;
const DEFAULT_TTL_SECONDS = 3600;

export interface VoiceTokenPayload {
  v: 1;
  tk: string;
  uid: string | null;
  oid: string | null;
  iat: number;
  exp: number;
  aud: 'voice-rag';
}

export type MintVoiceTokenResult =
  | { ok: true; token: string; payload: VoiceTokenPayload }
  | { ok: false; reason: 'secret_not_configured' | 'invalid_ttl' };

export type VerifyVoiceTokenResult =
  | { ok: true; payload: VoiceTokenPayload }
  | { ok: false; status: 401 | 503; reason: string };

export interface MintVoiceTokenInput {
  scope: TenantScope;
  secret: string | undefined;
  ttlSeconds?: number;
  /** Epoch milliseconds; defaults to the current time. */
  now?: number;
}

export interface VerifyVoiceTokenOptions {
  secret: string | undefined;
  /** Epoch milliseconds; defaults to the current time. */
  now?: number;
}

function hasUsableSecret(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_VOICE_SECRET_LENGTH;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function hmac(secret: string, payloadB64: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64, 'utf8').digest('base64url');
}

/** RAG_VOICE_TOKEN_TTL_SECONDS from the typed env, falling back to one hour when unset or not a positive number. */
export function defaultVoiceTtlSeconds(): number {
  const parsed = Number(env.RAG_VOICE_TOKEN_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTL_SECONDS;
}

export function mintVoiceToken(input: MintVoiceTokenInput): MintVoiceTokenResult {
  if (!hasUsableSecret(input.secret)) return { ok: false, reason: 'secret_not_configured' };
  const ttl = input.ttlSeconds ?? defaultVoiceTtlSeconds();
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 1) return { ok: false, reason: 'invalid_ttl' };
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const payload: VoiceTokenPayload = {
    v: 1,
    tk: scopeKey(input.scope),
    uid: input.scope.userId,
    oid: input.scope.organizationId,
    iat,
    exp: iat + Math.floor(ttl),
    aud: VOICE_TOKEN_AUDIENCE,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { ok: true, token: `${payloadB64}.${hmac(input.secret, payloadB64)}`, payload };
}

function malformed(): { ok: false; status: 401; reason: string } {
  return { ok: false, status: 401, reason: 'malformed' };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function verifyVoiceToken(token: unknown, options: VerifyVoiceTokenOptions): VerifyVoiceTokenResult {
  if (!hasUsableSecret(options.secret)) return { ok: false, status: 503, reason: 'secret_not_configured' };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return malformed();
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return malformed();
  const [payloadB64, signature] = parts;

  const expected = hmac(options.secret, payloadB64);
  if (!crypto.timingSafeEqual(sha256(signature), sha256(expected))) {
    return { ok: false, status: 401, reason: 'bad_signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return malformed();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return malformed();
  const claims = parsed as Record<string, unknown>;
  if (
    typeof claims.v !== 'number' ||
    typeof claims.aud !== 'string' ||
    typeof claims.tk !== 'string' ||
    !isNullableString(claims.uid) ||
    !isNullableString(claims.oid) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return malformed();
  }
  if (claims.v !== 1) return { ok: false, status: 401, reason: 'bad_version' };
  if (claims.aud !== VOICE_TOKEN_AUDIENCE) return { ok: false, status: 401, reason: 'bad_audience' };

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const exp = claims.exp as number;
  const iat = claims.iat as number;
  if (exp <= nowSeconds) return { ok: false, status: 401, reason: 'expired' };
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, status: 401, reason: 'issued_in_future' };

  return {
    ok: true,
    payload: { v: 1, tk: claims.tk, uid: claims.uid, oid: claims.oid, iat, exp, aud: VOICE_TOKEN_AUDIENCE },
  };
}
