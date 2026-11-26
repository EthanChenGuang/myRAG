import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedText } from '@/lib/rag/lang/texts';
import { JID, SESSION_ID, USER_ID, fakeSupabaseAdmin, messageWebhook, type AdminCall } from '../helpers/whatsapp-handler-harness';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  admin: null as unknown,
  sendTextMessage: vi.fn(),
  recordOutputGuardEvents: vi.fn(),
  env: {
    WHATSAPP_DEFAULT_MODEL: 'openai/gpt-4o-mini',
    WHATSAPP_MAX_TOKENS: '4096',
    RAG_OUTPUT_LINK_ALLOWLIST: 'docs.example.com',
    NEXT_PUBLIC_SITE_URL: 'https://app.example.org',
    KOYEB_BAILEYS_URL: 'https://koyeb.example.test',
    KOYEB_API_KEY: 'test-koyeb-key-placeholder',
    FLYIO_BAILEYS_URL: 'https://flyio.example.test',
    FLYIO_API_KEY: 'test-flyio-key-placeholder',
  } as Record<string, string>,
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
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
vi.mock('@/lib/rag/security/security-events', () => ({ recordOutputGuardEvents: h.recordOutputGuardEvents }));

const USER_TEXT = 'Please summarise https://user-link.example.net/page for me';
const fetchMock = vi.fn();
const PHASE_52_KEYS = ['RAG_OUTPUT_GUARD', 'RAG_REGISTRY_TEXTS', 'RAG_SECURITY_EVENTS', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'];

beforeEach(() => {
  h.calls.length = 0;
  h.admin = fakeSupabaseAdmin(h.calls as AdminCall[]);
  h.sendTextMessage.mockReset();
  h.sendTextMessage.mockResolvedValue({ messageId: 'outgoing-1', status: 'sent' });
  h.recordOutputGuardEvents.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  for (const key of PHASE_52_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Handler = { sendWhatsAppResponse: (sessionId: string, to: string, response: string, userMessage?: string) => Promise<string> };

async function makeHandler() {
  const { WhatsAppWebhookHandler } = await import('@/lib/whatsapp/webhook-handler');
  return new WhatsAppWebhookHandler() as unknown as Handler;
}

async function send(reply: string, userMessage = USER_TEXT) {
  const handler = await makeHandler();
  await handler.sendWhatsAppResponse(SESSION_ID, JID, reply, userMessage);
  return h.sendTextMessage.mock.calls;
}

function chatBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const placeholder = () => fixedText('notices.link_removed', 'en');

describe('WhatsApp reply output guard: off', () => {
  it('sends the reply exactly as today, with no linkPreview field', async () => {
    const reply = 'See https://attacker.example/c?d=1 and docs.';
    const calls = await send(reply);
    expect(calls).toEqual([[SESSION_ID, JID, reply]]);
    expect(h.recordOutputGuardEvents).not.toHaveBeenCalled();
  });

  it('sends the chat request without a channel field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
    const handler = await makeHandler();
    await (handler as unknown as { handleWebhook: (p: unknown) => Promise<void> }).handleWebhook(messageWebhook('hello'));
    const body = chatBody();
    expect(body).not.toHaveProperty('channel');
    expect((body.data as Record<string, unknown>)).not.toHaveProperty('channel');
  });
});

describe('WhatsApp reply output guard: enforce', () => {
  beforeEach(() => vi.stubEnv('RAG_OUTPUT_GUARD', 'enforce'));

  it('replaces a non-allowlisted link and asks the service not to fetch a preview', async () => {
    const calls = await send('See https://attacker.example/c?d=1 for more.');
    expect(calls).toHaveLength(1);
    const [, , text, options] = calls[0]!;
    expect(text).not.toContain('attacker.example');
    expect(text).toContain(placeholder());
    expect(options).toEqual({ linkPreview: false });
  });

  it('keeps an allowlisted link, the site link and a link the user wrote', async () => {
    const reply = 'Read https://docs.example.com/guide and https://app.example.org/help and https://user-link.example.net/page today.';
    const calls = await send(reply);
    expect(calls[0]![2]).toBe(reply);
    expect(calls[0]![3]).toEqual({ linkPreview: false });
  });

  it('replaces a credential sentence exactly when the same reply had a link removed', async () => {
    const reply = 'Open https://attacker.example/login now. Please enter your password here to continue.';
    const calls = await send(reply);
    const text = calls[0]![2] as string;
    expect(text).toContain(fixedText('notices.credential_request_blocked', 'en'));
    expect(text).not.toMatch(/password/i);
    expect(text).not.toContain('attacker.example');
  });

  it('appends the plain-text warning notice when a credential sentence is only warned', async () => {
    const reply = 'Please enter your password here to continue.';
    const calls = await send(reply);
    const text = calls[0]![2] as string;
    expect(text.endsWith(fixedText('notices.credential_request_warning', 'en'))).toBe(true);
    expect(text.startsWith(reply)).toBe(true);
  });

  it('records the handler findings for channel whatsapp', async () => {
    await send('See https://attacker.example/c for more.');
    expect(h.recordOutputGuardEvents).toHaveBeenCalledTimes(1);
    const [summary, context] = h.recordOutputGuardEvents.mock.calls[0]!;
    expect(summary).toMatchObject({ mode: 'enforce', links_removed: 1 });
    expect(context).toMatchObject({ channel: 'whatsapp', tenantKey: 's:default', blocks: [], traceId: null });
  });

  it('sends channel whatsapp in the chat request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
    const handler = await makeHandler();
    await (handler as unknown as { handleWebhook: (p: unknown) => Promise<void> }).handleWebhook(messageWebhook('hello'));
    expect((chatBody().data as Record<string, unknown>).channel).toBe('whatsapp');
  });
});

describe('WhatsApp reply output guard: flag', () => {
  beforeEach(() => vi.stubEnv('RAG_OUTPUT_GUARD', 'flag'));

  it('leaves the text unchanged, still sends linkPreview false and records the findings', async () => {
    const reply = 'See https://attacker.example/c for more.';
    const calls = await send(reply);
    expect(calls).toEqual([[SESSION_ID, JID, reply, { linkPreview: false }]]);
    expect(h.recordOutputGuardEvents).toHaveBeenCalledTimes(1);
    expect(h.recordOutputGuardEvents.mock.calls[0]![0]).toMatchObject({ mode: 'flag', links_removed: 1 });
    expect(h.recordOutputGuardEvents.mock.calls[0]![1]).toMatchObject({ channel: 'whatsapp' });
  });
});

describe('another Phase 5.2 switch on', () => {
  it('adds channel whatsapp to the chat request while the guard stays off', async () => {
    vi.stubEnv('RAG_SECURITY_EVENTS', 'true');
    fetchMock.mockResolvedValueOnce(new Response('data: [DONE]\n\n', { status: 200 }));
    const handler = await makeHandler();
    await (handler as unknown as { handleWebhook: (p: unknown) => Promise<void> }).handleWebhook(messageWebhook('hello'));
    expect((chatBody().data as Record<string, unknown>).channel).toBe('whatsapp');
    expect(h.sendTextMessage.mock.calls[0]).toHaveLength(3);
  });
});

describe('provider clients', () => {
  it.each([
    ['koyeb', '@/lib/whatsapp/koyeb-client', 'KoyebWhatsAppClient', 'https://koyeb.example.test'],
    ['flyio', '@/lib/whatsapp/flyio-client', 'FlyioWhatsAppClient', 'https://flyio.example.test'],
  ])('%s sends linkPreview false only when asked', async (_name, path, exportName, base) => {
    const mod = (await import(path)) as Record<string, new () => {
      sendTextMessage: (s: string, t: string, m: string, o?: { linkPreview?: false }) => Promise<unknown>;
    }>;
    const client = new mod[exportName]!();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ messageId: 'm', status: 'sent' }), { status: 200 }));
    await client.sendTextMessage(SESSION_ID, JID, 'plain');
    await client.sendTextMessage(SESSION_ID, JID, 'plain', { linkPreview: false });
    const bodies = fetchMock.mock.calls.map(([url, init]) => [String(url), JSON.parse(String((init as RequestInit).body))]);
    expect(bodies[0]).toEqual([`${base}/api/messages/send`, { sessionId: SESSION_ID, to: JID, message: 'plain' }]);
    expect(bodies[1]).toEqual([`${base}/api/messages/send`, { sessionId: SESSION_ID, to: JID, message: 'plain', linkPreview: false }]);
  });

  it('getLinkPreviewHosts returns the host names from the health response, or null without an answer', async () => {
    const { KoyebWhatsAppClient } = await import('@/lib/whatsapp/koyeb-client');
    const client = new KoyebWhatsAppClient();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ok', linkPreviewHosts: ['docs.example.com', 42, 'bad host/'] }), { status: 200 }),
    );
    expect(await client.getLinkPreviewHosts()).toEqual(['docs.example.com']);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://koyeb.example.test/health');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    expect(await client.getLinkPreviewHosts()).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    expect(await client.getLinkPreviewHosts()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await client.getLinkPreviewHosts()).toBeNull();
  });
});
