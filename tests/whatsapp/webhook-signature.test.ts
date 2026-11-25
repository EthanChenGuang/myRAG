import crypto from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'test-webhook-secret-placeholder';

vi.mock('@/lib/env', () => ({
  env: {
    KOYEB_BAILEYS_URL: 'https://koyeb.example.test',
    KOYEB_API_KEY: 'test-koyeb-key-placeholder',
    FLYIO_BAILEYS_URL: 'https://flyio.example.test',
    FLYIO_API_KEY: 'test-flyio-key-placeholder',
    WHATSAPP_WEBHOOK_SECRET: 'test-webhook-secret-placeholder',
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe.each([
  ['KoyebWhatsAppClient', async () => new (await import('@/lib/whatsapp/koyeb-client')).KoyebWhatsAppClient()],
  ['FlyioWhatsAppClient', async () => new (await import('@/lib/whatsapp/flyio-client')).FlyioWhatsAppClient()],
])('%s.validateWebhookSignature', (_name, makeClient) => {
  const body = JSON.stringify({ sessionId: 'session-1', event: 'status', data: {} });
  const goodSignature = () => crypto.createHmac('sha256', SECRET).update(body).digest('hex');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a correct signature and compares with timingSafeEqual', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const client = await makeClient();

    expect(client.validateWebhookSignature(goodSignature(), body)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong signature with timingSafeEqual', async () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const client = await makeClient();

    expect(client.validateWebhookSignature('0'.repeat(64), body)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns false without throwing on a length mismatch or missing signature', async () => {
    const client = await makeClient();

    expect(client.validateWebhookSignature('abc', body)).toBe(false);
    expect(client.validateWebhookSignature('a'.repeat(200), body)).toBe(false);
    expect(client.validateWebhookSignature('', body)).toBe(false);
    expect(client.validateWebhookSignature(undefined as unknown as string, body)).toBe(false);
  });
});
