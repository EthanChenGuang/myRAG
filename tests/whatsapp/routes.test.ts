import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const WEBHOOK_SECRET = 'test-webhook-secret-placeholder';
const USER_ID = 'user-1';
const PHONE = '+10000000000';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    user: { id: 'user-1' } as { id: string } | null,
    authError: null as Error | null,
    sessionManager: {
      createSession: vi.fn(),
      getActiveSession: vi.fn(),
    },
    whatsappClient: {
      sendTextMessage: vi.fn(),
    } as Record<string, unknown>,
    webhookHandler: { handleWebhook: vi.fn() },
    adminRows: [] as Array<Record<string, unknown>>,
    adminQuery: [] as Array<[string, unknown[]]>,
    ssrQuery: [] as Array<[string, unknown[]]>,
  };

  function chain(log: Array<[string, unknown[]]>, result: () => unknown) {
    const node: Record<string, unknown> = {};
    for (const method of ['select', 'delete', 'eq', 'order']) {
      node[method] = (...args: unknown[]) => {
        log.push([method, args]);
        return node;
      };
    }
    node.then = (resolve: (value: unknown) => unknown) => resolve(result());
    return node;
  }

  const ssrClient = {
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: state.authError }),
    },
    from: (table: string) => {
      state.ssrQuery.push(['from', [table]]);
      return chain(state.ssrQuery, () => ({ data: null, error: null }));
    },
  };

  const adminClient = {
    from: (table: string) => {
      state.adminQuery.push(['from', [table]]);
      return chain(state.adminQuery, () => ({ data: state.adminRows, error: null }));
    },
  };

  return { state, ssrClient, adminClient };
});

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_WHATSAPP_ENABLED: 'true',
    WHATSAPP_WEBHOOK_SECRET: 'test-webhook-secret-placeholder',
    KOYEB_BAILEYS_URL: 'https://koyeb.example.test',
    KOYEB_API_KEY: 'test-koyeb-key-placeholder',
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssrClient }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => h.adminClient }));
vi.mock('@/lib/whatsapp/session-manager', () => ({ getSessionManager: () => h.state.sessionManager }));
vi.mock('@/lib/whatsapp/webhook-handler', () => ({ getWebhookHandler: () => h.state.webhookHandler }));
vi.mock('@/lib/whatsapp/client-factory', async () => {
  const { KoyebWhatsAppClient } = await import('@/lib/whatsapp/koyeb-client');
  return {
    getWhatsAppClient: () => Object.assign(new KoyebWhatsAppClient(), h.state.whatsappClient),
  };
});

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  h.state.user = { id: USER_ID };
  h.state.authError = null;
  h.state.sessionManager.createSession.mockReset();
  h.state.sessionManager.getActiveSession.mockReset();
  h.state.whatsappClient = { sendTextMessage: vi.fn() };
  h.state.webhookHandler.handleWebhook.mockReset();
  h.state.adminRows = [];
  h.state.adminQuery.length = 0;
  h.state.ssrQuery.length = 0;
});

describe('POST /api/whatsapp/connect', () => {
  const sessionBody = {
    id: 'row-1',
    sessionId: 'session-1',
    status: 'qr_pending',
    phoneNumber: 'pending_session-1',
    qrCode: 'qr-data',
    qrExpiresAt: '2030-01-01T00:00:00.000Z',
  };

  it('creates the session for the authenticated user', async () => {
    h.state.sessionManager.createSession.mockResolvedValue(sessionBody);
    const { POST } = await import('@/app/api/whatsapp/connect/route');

    const response = await POST(jsonRequest('http://localhost/api/whatsapp/connect', 'POST'));

    expect(response.status).toBe(200);
    expect(h.state.sessionManager.createSession).toHaveBeenCalledWith(USER_ID);
    expect((await response.json()).session.sessionId).toBe('session-1');
  });

  it('rejects unauthenticated requests without creating a session', async () => {
    h.state.user = null;
    const { POST } = await import('@/app/api/whatsapp/connect/route');

    const response = await POST(jsonRequest('http://localhost/api/whatsapp/connect', 'POST'));

    expect(response.status).toBe(401);
    expect(h.state.sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('returns the existing session of the same user when one already exists', async () => {
    h.state.sessionManager.createSession.mockRejectedValue(
      Object.assign(new Error('User already has an active WhatsApp session'), { code: 'SESSION_EXISTS' })
    );
    h.state.sessionManager.getActiveSession.mockResolvedValue(sessionBody);
    const { POST } = await import('@/app/api/whatsapp/connect/route');

    const response = await POST(jsonRequest('http://localhost/api/whatsapp/connect', 'POST'));

    expect(response.status).toBe(409);
    expect(h.state.sessionManager.getActiveSession).toHaveBeenCalledWith(USER_ID);
    expect((await response.json()).session.sessionId).toBe('session-1');
  });
});

describe('/api/whatsapp/conversations', () => {
  it('GET rejects unauthenticated requests', async () => {
    h.state.user = null;
    const { GET } = await import('@/app/api/whatsapp/conversations/route');

    const response = await GET(jsonRequest('http://localhost/api/whatsapp/conversations', 'GET'));

    expect(response.status).toBe(401);
    expect(h.state.adminQuery).toEqual([]);
  });

  it('GET lists the conversations of the authenticated user only', async () => {
    h.state.adminRows = [
      {
        id: 'conv-1',
        chat_id: 'chat-1',
        phone_number: PHONE,
        contact_name: null,
        created_at: '2030-01-01T00:00:00.000Z',
        updated_at: '2030-01-02T00:00:00.000Z',
        chats: {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ text: 'hello there' }], createdAt: '2030-01-02T00:00:00.000Z' },
          ],
        },
      },
    ];
    const { GET } = await import('@/app/api/whatsapp/conversations/route');

    const response = await GET(jsonRequest('http://localhost/api/whatsapp/conversations', 'GET'));

    expect(response.status).toBe(200);
    expect(h.state.adminQuery).toContainEqual(['eq', ['user_id', USER_ID]]);
    const body = await response.json();
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]).toMatchObject({
      id: 'conv-1',
      contactName: PHONE,
      unreadCount: 1,
      lastMessage: { content: 'hello there', isFromMe: true },
    });
  });

  it('DELETE rejects unauthenticated requests without touching the database', async () => {
    h.state.user = null;
    const { DELETE } = await import('@/app/api/whatsapp/conversations/route');

    const response = await DELETE(jsonRequest('http://localhost/api/whatsapp/conversations?id=conv-1', 'DELETE'));

    expect(response.status).toBe(401);
    expect(h.state.ssrQuery).toEqual([]);
    expect(h.state.adminQuery).toEqual([]);
  });

  it('DELETE removes only a conversation owned by the authenticated user', async () => {
    const { DELETE } = await import('@/app/api/whatsapp/conversations/route');

    const response = await DELETE(jsonRequest('http://localhost/api/whatsapp/conversations?id=conv-1', 'DELETE'));

    expect(response.status).toBe(200);
    expect(h.state.ssrQuery).toEqual([
      ['from', ['whatsapp_conversations']],
      ['delete', []],
      ['eq', ['id', 'conv-1']],
      ['eq', ['user_id', USER_ID]],
    ]);
  });
});

describe('POST /api/whatsapp/test-numbers', () => {
  it('returns the message id and status of the send result', async () => {
    (h.state.whatsappClient.sendTextMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messageId: 'msg-1',
      status: 'sent',
    });
    const { POST } = await import('@/app/api/whatsapp/test-numbers/route');

    const response = await POST(
      jsonRequest('http://localhost/api/whatsapp/test-numbers', 'POST', { sessionId: 'session-1', phoneNumber: '10000000000' })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, messageId: 'msg-1', status: 'sent' });
    expect(h.state.whatsappClient.sendTextMessage).toHaveBeenCalledWith(
      'session-1',
      '10000000000@s.whatsapp.net',
      expect.any(String)
    );
  });
});

describe('POST /api/whatsapp/webhook', () => {
  const payload = JSON.stringify({ sessionId: 'session-1', event: 'status', data: {} });

  function sign(body: string) {
    return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  }

  it('rejects a bad signature with 401 and does not process the event', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await POST(
      jsonRequest('http://localhost/api/whatsapp/webhook', 'POST', payload, { 'x-webhook-signature': 'bad-signature' })
    );

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 401', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await POST(jsonRequest('http://localhost/api/whatsapp/webhook', 'POST', payload));

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed payload and hands it to the webhook handler', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await POST(
      jsonRequest('http://localhost/api/whatsapp/webhook', 'POST', payload, { 'x-webhook-signature': sign(payload) })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, received: true });
    expect(h.state.webhookHandler.handleWebhook).toHaveBeenCalledWith(JSON.parse(payload));
  });
});
