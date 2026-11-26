import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JID, SESSION_ID, USER_ID, chatRouteSseBody, fakeSupabaseAdmin, messageWebhook, type AdminCall } from '../helpers/whatsapp-handler-harness';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  admin: null as unknown,
  sendTextMessage: vi.fn(),
}));

vi.mock('@/lib/env', () => ({ env: { WHATSAPP_DEFAULT_MODEL: 'openai/gpt-4o-mini', WHATSAPP_MAX_TOKENS: '4096' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: new Proxy({}, { get: (_target, key) => (h.admin as Record<string | symbol, unknown>)[key] }),
}));
vi.mock('@/lib/title-generator', () => ({ generateTitle: vi.fn(() => 'title'), generateSmartTitle: vi.fn(async () => 'title') }));
vi.mock('@/lib/whatsapp/session-manager', () => ({
  getSessionManager: () => ({
    getSessionById: async () => ({ sessionId: SESSION_ID, userId: USER_ID, status: 'connected' }),
    updateSessionStatus: vi.fn(),
  }),
}));
vi.mock('@/lib/whatsapp/client-factory', () => ({ getWhatsAppClient: () => ({ sendTextMessage: h.sendTextMessage }) }));

const FALLBACK = "I received your message but couldn't generate a proper response. Please try again.";
const fetchMock = vi.fn();

beforeEach(() => {
  h.calls.length = 0;
  h.admin = fakeSupabaseAdmin(h.calls as AdminCall[]);
  h.sendTextMessage.mockReset();
  h.sendTextMessage.mockResolvedValue({ messageId: 'outgoing-1', status: 'sent' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function runWithChatStream(pieces: string[]) {
  const body = await chatRouteSseBody(pieces);
  fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const { WhatsAppWebhookHandler } = await import('@/lib/whatsapp/webhook-handler');
  const sendWhatsAppResponse = vi.spyOn(
    WhatsAppWebhookHandler.prototype as unknown as { sendWhatsAppResponse: (...args: unknown[]) => Promise<void> },
    'sendWhatsAppResponse',
  );
  const handler = new WhatsAppWebhookHandler();
  await handler.handleWebhook(messageWebhook('What does the synthetic note say?') as never);
  return { body, sendWhatsAppResponse };
}

describe('WhatsApp reply path against the chat route UI message stream (D-91)', () => {
  it('feeds the handler the real SSE data lines of the UI message stream', async () => {
    const { body } = await runWithChatStream(['The synthetic note ', 'lists three items.']);
    expect(body).toContain('data: {"type":"text-delta"');
    expect(body).toContain('"delta":"The synthetic note "');
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/chat$/);
  });

  it('collects no streamed text and sends only the fixed fallback sentence', async () => {
    const { sendWhatsAppResponse } = await runWithChatStream(['The synthetic note ', 'lists three items.']);
    expect(sendWhatsAppResponse).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppResponse).toHaveBeenCalledWith(SESSION_ID, JID, FALLBACK);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage).toHaveBeenCalledWith(SESSION_ID, JID, FALLBACK);
  });
});
