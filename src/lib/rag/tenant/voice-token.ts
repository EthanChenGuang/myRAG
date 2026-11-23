import type { TenantScope } from './scope';

export const VOICE_TOKEN_AUDIENCE = 'voice-rag';

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
  now?: number;
}

export interface VerifyVoiceTokenOptions {
  secret: string | undefined;
  now?: number;
}

export function mintVoiceToken(_input: MintVoiceTokenInput): MintVoiceTokenResult {
  return { ok: false, reason: 'invalid_ttl' };
}

export function verifyVoiceToken(_token: unknown, _options: VerifyVoiceTokenOptions): VerifyVoiceTokenResult {
  return { ok: false, status: 503, reason: 'not_implemented' };
}
