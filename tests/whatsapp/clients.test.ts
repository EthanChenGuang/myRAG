import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_URL = 'https://koyeb.example.test';
const API_KEY = 'test-koyeb-key-placeholder';

const h = vi.hoisted(() => ({
  sessionManager: {
    getSessionById: vi.fn(),
    updateSessionStatus: vi.fn(),
  },
  whatsappClient: {
    getSessionStatus: vi.fn(),
  },
}));

vi.mock('@/lib/env', () => ({
  env: {
    KOYEB_BAILEYS_URL: 'https://koyeb.example.test',
    KOYEB_API_KEY: 'test-koyeb-key-placeholder',
    WHATSAPP_WEBHOOK_SECRET: 'test-webhook-secret-placeholder',
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: () => {
      throw new Error('supabase unavailable in test');
    },
  },
}));
vi.mock('@/lib/title-generator', () => ({
  generateTitle: vi.fn(),
  generateSmartTitle: vi.fn(),
}));
vi.mock('@/lib/whatsapp/session-manager', () => ({
  getSessionManager: () => h.sessionManager,
}));
vi.mock('@/lib/whatsapp/client-factory', () => ({
  getWhatsAppClient: () => h.whatsappClient,
}));

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('KoyebWhatsAppClient.sendMedia', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function makeClient() {
    const { KoyebWhatsAppClient } = await import('@/lib/whatsapp/koyeb-client');
    return new KoyebWhatsAppClient();
  }

  it('implements the abstract sendMedia of the base client', async () => {
    const client = await makeClient();
    expect(typeof client.sendMedia).toBe('function');
  });

  it('posts an image payload to the messages endpoint with auth and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messageId: 'msg-1', status: 'sent' }));
    const client = await makeClient();

    const result = await client.sendMedia(
      'session-1',
      '+10000000000',
      'https://example.com/pic.png',
      'a caption',
      'image/png'
    );

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/messages/send`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 'session-1',
      to: '+10000000000',
      message: { image: { url: 'https://example.com/pic.png', caption: 'a caption' } },
    });
  });

  it('falls back to a document payload for other mime types', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ messageId: 'msg-2' }));
    const client = await makeClient();

    await client.sendMedia('session-1', '+10000000000', 'https://example.com/files/report.pdf', undefined, 'application/pdf');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).message).toEqual({
      document: { url: 'https://example.com/files/report.pdf', filename: 'report.pdf' },
    });
  });

  it('uploads media as a Blob part with the auth header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ mediaId: 'media-1' }));
    const client = await makeClient();

    await client.uploadMedia('session-1', Buffer.from('hello'), 'hello.txt', 'text/plain');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/media/upload`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });
    const file = (init.body as FormData).get('file') as File;
    expect(file.name).toBe('hello.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('hello');
  });
});

describe('WhatsAppWebhookHandler session status reconciliation', () => {
  beforeEach(() => {
    h.sessionManager.getSessionById.mockReset();
    h.sessionManager.updateSessionStatus.mockReset();
    h.whatsappClient.getSessionStatus.mockReset();
  });

  async function runMessage() {
    const { WhatsAppWebhookHandler } = await import('@/lib/whatsapp/webhook-handler');
    const handler = new WhatsAppWebhookHandler();
    try {
      await handler.handleWebhook({
        event: 'message',
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
        data: { from: '10000000000@s.whatsapp.net', messageId: 'm-1' },
      } as never);
    } catch {
      // the conversation lookup is unavailable in this test; only the status branch is under test
    }
  }

  it('marks the session connected when the provider reports isConnected', async () => {
    h.sessionManager.getSessionById.mockResolvedValue({ sessionId: 'session-1', userId: 'user-1', status: 'disconnected' });
    h.whatsappClient.getSessionStatus.mockResolvedValue({ status: 'connected', isConnected: true });

    await runMessage();

    expect(h.whatsappClient.getSessionStatus).toHaveBeenCalledWith('session-1');
    expect(h.sessionManager.updateSessionStatus).toHaveBeenCalledWith('session-1', 'connected', {
      phoneNumber: '10000000000',
    });
  });

  it('leaves the session untouched when the provider reports it disconnected', async () => {
    h.sessionManager.getSessionById.mockResolvedValue({ sessionId: 'session-1', userId: 'user-1', status: 'disconnected' });
    h.whatsappClient.getSessionStatus.mockResolvedValue({ status: 'disconnected', isConnected: false });

    await runMessage();

    expect(h.whatsappClient.getSessionStatus).toHaveBeenCalledWith('session-1');
    expect(h.sessionManager.updateSessionStatus).not.toHaveBeenCalled();
  });
});
