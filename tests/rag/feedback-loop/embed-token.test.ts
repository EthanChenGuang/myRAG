import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintVoiceToken } from '@/lib/rag/tenant/voice-token';
import { mintScope } from '@/lib/rag/tenant/scope';
import {
  EMBED_FEEDBACK_AUDIENCE,
  mintEmbedFeedbackToken,
  verifyEmbedFeedbackToken,
} from '@/lib/rag/feedback-loop/embed-token';

const SECRET = 'e'.repeat(40);
const OTHER_SECRET = 'f'.repeat(40);
const NOW = Date.parse('2026-11-25T12:00:00Z');
const TRACE = '0123456789abcdef0123456789abcdef';
const TENANT = 'o:22222222-2222-4222-8222-222222222222';
const DAY_MS = 24 * 3600 * 1000;

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payload: unknown, secret = SECRET): string {
  const body = b64(payload);
  return `${body}.${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64url')}`;
}

function claims(overrides: Record<string, unknown> = {}) {
  const iat = Math.floor(NOW / 1000);
  return { v: 1, aud: EMBED_FEEDBACK_AUDIENCE, tid: TRACE, tk: TENANT, iat, exp: iat + 24 * 3600, ...overrides };
}

describe('embed feedback token (D-11)', () => {
  it('mint then verify returns the trace id and tenant key', () => {
    const token = mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT }, { secret: SECRET, now: NOW });
    expect(typeof token).toBe('string');
    expect(verifyEmbedFeedbackToken(token, { secret: SECRET, now: NOW })).toEqual({ traceId: TRACE, tenantKey: TENANT });
    expect(verifyEmbedFeedbackToken(token, { secret: SECRET, now: NOW + DAY_MS - 1000 })).toEqual({ traceId: TRACE, tenantKey: TENANT });
  });

  it('signs the documented claims with HMAC-SHA256 and a 24 h expiry', () => {
    const token = mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: 's:default' }, { secret: SECRET, now: NOW }) as string;
    const [body, signature] = token.split('.');
    expect(signature).toBe(crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64url'));
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ aud: 'embed-feedback', tid: TRACE, tk: 's:default' });
    expect(payload.exp - Math.floor(NOW / 1000)).toBe(24 * 3600);
  });

  it('accepts a hand-signed token with the documented claims', () => {
    expect(verifyEmbedFeedbackToken(sign(claims()), { secret: SECRET, now: NOW })).toEqual({ traceId: TRACE, tenantKey: TENANT });
  });

  it('a secret shorter than 32 characters mints nothing and verifies nothing', () => {
    expect(mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT }, { secret: 'x'.repeat(31), now: NOW })).toBeNull();
    expect(mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT }, { secret: null, now: NOW })).toBeNull();
    expect(verifyEmbedFeedbackToken(sign(claims(), 'x'.repeat(31)), { secret: 'x'.repeat(31), now: NOW })).toBeNull();
  });

  it('refuses to mint for a malformed trace id or tenant key', () => {
    expect(mintEmbedFeedbackToken({ traceId: 'ABC', tenantKey: TENANT }, { secret: SECRET, now: NOW })).toBeNull();
    expect(mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: 'x:bad' }, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a wrong signature', () => {
    expect(verifyEmbedFeedbackToken(sign(claims(), OTHER_SECRET), { secret: SECRET, now: NOW })).toBeNull();
    const token = sign(claims());
    expect(verifyEmbedFeedbackToken(`${token}x`, { secret: SECRET, now: NOW })).toBeNull();
    const [, signature] = token.split('.');
    expect(verifyEmbedFeedbackToken(`${b64(claims({ tk: 's:default' }))}.${signature}`, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a wrong audience, including a voice-rag token signed with the same secret', () => {
    expect(verifyEmbedFeedbackToken(sign(claims({ aud: 'voice-rag' })), { secret: SECRET, now: NOW })).toBeNull();
    const voice = mintVoiceToken({ scope: mintScope('single', null, null), secret: SECRET, now: NOW });
    if (!voice.ok) throw new Error('voice token should mint');
    expect(verifyEmbedFeedbackToken(voice.token, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects an expired token beyond the 30 s skew and accepts one within it', () => {
    const token = mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT }, { secret: SECRET, now: NOW }) as string;
    expect(verifyEmbedFeedbackToken(token, { secret: SECRET, now: NOW + DAY_MS + 20_000 })).not.toBeNull();
    expect(verifyEmbedFeedbackToken(token, { secret: SECRET, now: NOW + DAY_MS + 31_000 })).toBeNull();
    expect(verifyEmbedFeedbackToken(sign(claims({ iat: Math.floor(NOW / 1000) + 120 })), { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a token longer than 4096 characters', () => {
    const long = sign(claims({ pad: 'p'.repeat(4200) }));
    expect(long.length).toBeGreaterThan(4096);
    expect(verifyEmbedFeedbackToken(long, { secret: SECRET, now: NOW })).toBeNull();
  });

  it('rejects a malformed tenant key and a trace id that is not 32 lowercase hex', () => {
    for (const tk of ['x:bad', 'o:not-a-uuid', 'O:22222222-2222-4222-8222-222222222222', 's:default ', '', 7]) {
      expect(verifyEmbedFeedbackToken(sign(claims({ tk })), { secret: SECRET, now: NOW }), String(tk)).toBeNull();
    }
    for (const tid of ['0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef', `${TRACE}00`, 'g'.repeat(32), null]) {
      expect(verifyEmbedFeedbackToken(sign(claims({ tid })), { secret: SECRET, now: NOW }), String(tid)).toBeNull();
    }
  });

  it('rejects structurally malformed input', () => {
    for (const token of [undefined, null, 42, '', 'abc', 'a.b.c', '.sig', `${b64('x')}.`]) {
      expect(verifyEmbedFeedbackToken(token, { secret: SECRET, now: NOW })).toBeNull();
    }
    expect(verifyEmbedFeedbackToken(sign(['array']), { secret: SECRET, now: NOW })).toBeNull();
    expect(verifyEmbedFeedbackToken(sign(claims({ exp: 'soon' })), { secret: SECRET, now: NOW })).toBeNull();
    expect(verifyEmbedFeedbackToken(sign(claims({ v: 2 })), { secret: SECRET, now: NOW })).toBeNull();
  });

  it('reads the secret from RAG_EMBED_FEEDBACK_SECRET only while the embed rating is enabled', () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { on: env.RAG_EMBED_FEEDBACK, secret: env.RAG_EMBED_FEEDBACK_SECRET };
    try {
      env.RAG_EMBED_FEEDBACK_SECRET = SECRET;
      env.RAG_EMBED_FEEDBACK = 'false';
      expect(mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT }, { now: NOW })).toBeNull();
      env.RAG_EMBED_FEEDBACK = 'true';
      const token = mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT }, { now: NOW });
      expect(verifyEmbedFeedbackToken(token, { now: NOW })).toEqual({ traceId: TRACE, tenantKey: TENANT });
      env.RAG_EMBED_FEEDBACK = 'false';
      expect(verifyEmbedFeedbackToken(token, { now: NOW })).toBeNull();
    } finally {
      if (saved.on === undefined) delete env.RAG_EMBED_FEEDBACK;
      else env.RAG_EMBED_FEEDBACK = saved.on;
      if (saved.secret === undefined) delete env.RAG_EMBED_FEEDBACK_SECRET;
      else env.RAG_EMBED_FEEDBACK_SECRET = saved.secret;
    }
  });
});
