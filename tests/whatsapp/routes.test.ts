import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const WEBHOOK_SECRET = 'test-webhook-secret-placeholder';
const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const PHONE = '+10000000000';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const state = {
    user: { id: 'user-1' } as { id: string } | null,
    authError: null as Error | null,
    authThrows: false,
    sessionManager: {
      createSession: vi.fn(),
      getActiveSession: vi.fn(),
      getSessionById: vi.fn(),
    },
    env: {
      NEXT_PUBLIC_WHATSAPP_ENABLED: 'true',
      WHATSAPP_WEBHOOK_SECRET: 'test-webhook-secret-placeholder' as string,
      WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: '' as string,
      KOYEB_BAILEYS_URL: 'https://koyeb.example.test',
      KOYEB_API_KEY: 'test-koyeb-key-placeholder',
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
      getUser: async () => {
        if (state.authThrows) throw new Error('auth down');
        return { data: { user: state.user }, error: state.authError };
      },
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

vi.mock('@/lib/env', () => ({ env: h.state.env }));
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
  h.state.authThrows = false;
  h.state.sessionManager.createSession.mockReset();
  h.state.sessionManager.getActiveSession.mockReset();
  h.state.sessionManager.getSessionById.mockReset();
  h.state.sessionManager.getSessionById.mockImplementation(async (sessionId: string) =>
    sessionId === 'session-1' ? { sessionId, userId: USER_ID } : sessionId === 'session-other' ? { sessionId, userId: OTHER_USER_ID } : null
  );
  h.state.env.WHATSAPP_WEBHOOK_SECRET = WEBHOOK_SECRET;
  h.state.env.WHATSAPP_WEBHOOK_ALLOW_UNSIGNED = '';
  vi.unstubAllEnvs();
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
  const url = 'http://localhost/api/whatsapp/test-numbers';
  const body = { sessionId: 'session-1', phoneNumber: '10000000000' };

  it('returns the message id and status of the send result', async () => {
    (h.state.whatsappClient.sendTextMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messageId: 'msg-1',
      status: 'sent',
    });
    const { POST } = await import('@/app/api/whatsapp/test-numbers/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, messageId: 'msg-1', status: 'sent' });
    expect(h.state.whatsappClient.sendTextMessage).toHaveBeenCalledWith(
      'session-1',
      '10000000000@s.whatsapp.net',
      expect.any(String)
    );
  });

  it('rejects unauthenticated requests without sending', async () => {
    h.state.user = null;
    const { POST } = await import('@/app/api/whatsapp/test-numbers/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(401);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it('returns 503 when the auth lookup throws', async () => {
    h.state.authThrows = true;
    const { POST } = await import('@/app/api/whatsapp/test-numbers/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(503);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it("rejects another user's session with 403 without sending", async () => {
    const { POST } = await import('@/app/api/whatsapp/test-numbers/route');

    const response = await POST(jsonRequest(url, 'POST', { ...body, sessionId: 'session-other' }));

    expect(response.status).toBe(403);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it('returns 404 in production without sending', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { POST } = await import('@/app/api/whatsapp/test-numbers/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(404);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/test', () => {
  const url = 'http://localhost/api/whatsapp/test';
  const body = { sessionId: 'session-1', to: '10000000000@s.whatsapp.net', message: 'hello' };

  it('sends for the owner of the session', async () => {
    (h.state.whatsappClient.sendTextMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      messageId: 'msg-1',
      status: 'sent',
    });
    const { POST } = await import('@/app/api/whatsapp/test/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(200);
    expect(h.state.whatsappClient.sendTextMessage).toHaveBeenCalled();
  });

  it('returns 401 with no session and does not send', async () => {
    h.state.user = null;
    const { POST } = await import('@/app/api/whatsapp/test/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(401);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it("returns 403 for another user's sessionId and does not send", async () => {
    const { POST } = await import('@/app/api/whatsapp/test/route');

    const response = await POST(jsonRequest(url, 'POST', { ...body, sessionId: 'session-other' }));

    expect(response.status).toBe(403);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });

  it('returns 404 in production and does not send', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { POST } = await import('@/app/api/whatsapp/test/route');

    const response = await POST(jsonRequest(url, 'POST', body));

    expect(response.status).toBe(404);
    expect(h.state.whatsappClient.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe('/api/whatsapp/monitor', () => {
  const url = 'http://localhost/api/whatsapp/monitor';

  it('GET returns 401 with no session', async () => {
    h.state.user = null;
    const { GET } = await import('@/app/api/whatsapp/monitor/route');

    const response = await GET();

    expect(response.status).toBe(401);
  });

  it('POST returns 401 with no session', async () => {
    h.state.user = null;
    const { POST } = await import('@/app/api/whatsapp/monitor/route');

    const response = await POST(jsonRequest(url, 'POST', { action: 'stop', sessionId: 'session-1' }));

    expect(response.status).toBe(401);
  });

  it("POST returns 403 for another user's session on force_reconnect", async () => {
    const { POST } = await import('@/app/api/whatsapp/monitor/route');

    const response = await POST(jsonRequest(url, 'POST', { action: 'force_reconnect', sessionId: 'session-other' }));

    expect(response.status).toBe(403);
  });

  it('POST returns 400 without a sessionId on force_reconnect', async () => {
    const { POST } = await import('@/app/api/whatsapp/monitor/route');

    const response = await POST(jsonRequest(url, 'POST', { action: 'force_reconnect' }));

    expect(response.status).toBe(400);
  });
});

describe('POST /api/whatsapp/webhook', () => {
  let nonce = 0;

  function makePayload(sentAt: Date = new Date()) {
    nonce += 1;
    return JSON.stringify({ sessionId: 'session-1', event: 'status', data: { update: nonce }, timestamp: sentAt.toISOString() });
  }

  function sign(body: string) {
    return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  }

  function send(POST: (request: NextRequest) => Promise<Response>, body: string, signature: string | null = sign(body)) {
    return POST(
      jsonRequest('http://localhost/api/whatsapp/webhook', 'POST', body, signature ? { 'x-webhook-signature': signature } : {})
    );
  }

  it('rejects a bad signature with 401 and does not process the event', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(), 'bad-signature');

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 401', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(), null);

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed payload and hands it to the webhook handler', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');
    const payload = makePayload();

    const response = await send(POST, payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, received: true });
    expect(h.state.webhookHandler.handleWebhook).toHaveBeenCalledWith(JSON.parse(payload));
  });

  it('rejects a validly signed payload with a stale timestamp with 401', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(new Date(Date.now() - 6 * 60 * 1000)));

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a validly signed payload dated in the future with 401', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(new Date(Date.now() + 10 * 60 * 1000)));

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a validly signed payload without a timestamp with 401', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');
    const body = JSON.stringify({ sessionId: 'session-1', event: 'status', data: { untimed: true } });

    const response = await send(POST, body);

    expect(response.status).toBe(401);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('processes a replayed signed body only once', async () => {
    const { POST } = await import('@/app/api/whatsapp/webhook/route');
    const payload = makePayload();

    const first = await send(POST, payload);
    const second = await send(POST, payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(h.state.webhookHandler.handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('returns 503 in production when the secret is unset and does not call the handler', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    h.state.env.WHATSAPP_WEBHOOK_SECRET = '';
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(), null);

    expect(response.status).toBe(503);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('returns 503 in development when the secret is unset and no opt-in is set', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    h.state.env.WHATSAPP_WEBHOOK_SECRET = '';
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(), null);

    expect(response.status).toBe(503);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('accepts unsigned webhooks in development only with the explicit opt-in', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    h.state.env.WHATSAPP_WEBHOOK_SECRET = '';
    h.state.env.WHATSAPP_WEBHOOK_ALLOW_UNSIGNED = 'true';
    const { POST } = await import('@/app/api/whatsapp/webhook/route');
    const payload = makePayload();

    const response = await send(POST, payload, null);

    expect(response.status).toBe(200);
    expect(h.state.webhookHandler.handleWebhook).toHaveBeenCalledWith(JSON.parse(payload));
  });

  it('ignores the opt-in in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    h.state.env.WHATSAPP_WEBHOOK_SECRET = '';
    h.state.env.WHATSAPP_WEBHOOK_ALLOW_UNSIGNED = 'true';
    const { POST } = await import('@/app/api/whatsapp/webhook/route');

    const response = await send(POST, makePayload(), null);

    expect(response.status).toBe(503);
    expect(h.state.webhookHandler.handleWebhook).not.toHaveBeenCalled();
  });

  it('does not log message text or phone numbers', async () => {
    const { logger } = await import('@/lib/logger');
    const { POST } = await import('@/app/api/whatsapp/webhook/route');
    nonce += 1;
    const body = JSON.stringify({
      sessionId: 'session-1',
      event: 'message',
      data: { key: { remoteJid: `${PHONE.slice(1)}@s.whatsapp.net`, fromMe: false, id: 'msg-log-1' }, message: { conversation: 'private message text' } },
      timestamp: new Date().toISOString(),
    });

    await send(POST, body);

    const logged = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(logged).not.toContain('private message text');
    expect(logged).not.toContain(PHONE.slice(1));
    expect(logged).toContain('msg-log-1');
  });
});
