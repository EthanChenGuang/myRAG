import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyPolarWebhookSignature } from '@/lib/polar-webhook';

const SECRET = 'polar-webhook-secret-placeholder';
const BODY = JSON.stringify({ type: 'subscription.created', data: {} });
const NOW_MS = 1_800_000_000_000;

function sign(secret: string, id: string, timestamp: string, payload: string): string {
  return `v1,${createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${id}.${timestamp}.${payload}`).digest('base64')}`;
}

function signedHeaders(timestamp = String(Math.floor(NOW_MS / 1000)), secret = SECRET) {
  return { id: 'msg_1', timestamp, signature: sign(secret, 'msg_1', timestamp, BODY) };
}

describe('verifyPolarWebhookSignature', () => {
  it('accepts a correctly signed payload', () => {
    expect(verifyPolarWebhookSignature(BODY, signedHeaders(), SECRET, NOW_MS)).toBe(true);
  });

  it('accepts when one of several space-separated signatures matches', () => {
    const headers = signedHeaders();
    headers.signature = `v1,AAAA ${headers.signature}`;
    expect(verifyPolarWebhookSignature(BODY, headers, SECRET, NOW_MS)).toBe(true);
  });

  it('accepts a whsec_ prefixed base64 secret', () => {
    const raw = Buffer.from('another-secret-placeholder');
    const timestamp = String(Math.floor(NOW_MS / 1000));
    const signature = `v1,${createHmac('sha256', raw).update(`msg_1.${timestamp}.${BODY}`).digest('base64')}`;
    expect(
      verifyPolarWebhookSignature(BODY, { id: 'msg_1', timestamp, signature }, `whsec_${raw.toString('base64')}`, NOW_MS),
    ).toBe(true);
  });

  it('rejects a missing secret even when a signature is present', () => {
    expect(verifyPolarWebhookSignature(BODY, signedHeaders(), undefined, NOW_MS)).toBe(false);
    expect(verifyPolarWebhookSignature(BODY, signedHeaders(), '', NOW_MS)).toBe(false);
  });

  it('rejects missing headers, a wrong secret, a tampered body and a stale timestamp', () => {
    expect(verifyPolarWebhookSignature(BODY, { id: null, timestamp: null, signature: null }, SECRET, NOW_MS)).toBe(false);
    expect(verifyPolarWebhookSignature(BODY, signedHeaders(undefined, 'other-secret'), SECRET, NOW_MS)).toBe(false);
    expect(verifyPolarWebhookSignature(`${BODY} `, signedHeaders(), SECRET, NOW_MS)).toBe(false);
    const stale = String(Math.floor(NOW_MS / 1000) - 3600);
    expect(verifyPolarWebhookSignature(BODY, signedHeaders(stale), SECRET, NOW_MS)).toBe(false);
  });
});

describe('POST /api/webhooks (Polar)', () => {
  const previousSecret = process.env.POLAR_WEBHOOK_SECRET;

  async function load() {
    vi.resetModules();
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
    return import('@/app/api/webhooks/route');
  }

  function post(headers: Record<string, string> = {}) {
    return new Request('http://localhost/api/webhooks', { method: 'POST', headers, body: BODY });
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@supabase/supabase-js');
    if (previousSecret === undefined) delete process.env.POLAR_WEBHOOK_SECRET;
    else process.env.POLAR_WEBHOOK_SECRET = previousSecret;
  });

  it('answers 503 when the secret is not configured', async () => {
    delete process.env.POLAR_WEBHOOK_SECRET;
    const { POST } = await load();
    expect((await POST(post())).status).toBe(503);
  });

  it('answers 401 for an unsigned request outside production', async () => {
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    const { POST } = await load();
    expect((await POST(post())).status).toBe(401);
  });

  it('answers 401 for a forged signature', async () => {
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    const { POST } = await load();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await POST(
      post({ 'webhook-id': 'msg_1', 'webhook-timestamp': timestamp, 'webhook-signature': sign('wrong', 'msg_1', timestamp, BODY) }),
    );
    expect(response.status).toBe(401);
  });

  it('answers 200 for a correctly signed request', async () => {
    process.env.POLAR_WEBHOOK_SECRET = SECRET;
    const { POST } = await load();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await POST(
      post({ 'webhook-id': 'msg_1', 'webhook-timestamp': timestamp, 'webhook-signature': sign(SECRET, 'msg_1', timestamp, BODY) }),
    );
    expect(response.status).toBe(200);
  });
});
