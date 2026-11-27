import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedText } from '@/lib/rag/lang/texts';
import { JID, SESSION_ID, USER_ID, chatRouteSseBody, fakeSupabaseAdmin, messageWebhook, type AdminCall } from '../helpers/whatsapp-handler-harness';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  admin: null as unknown,
  sendTextMessage: vi.fn(),
  env: {
    WHATSAPP_DEFAULT_MODEL: 'openai/gpt-4o-mini',
    WHATSAPP_MAX_TOKENS: '4096',
    RAG_OUTPUT_LINK_ALLOWLIST: 'docs.example.com',
    NEXT_PUBLIC_SITE_URL: 'https://app.example.org',
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
vi.mock('@/lib/rag/security/security-events', () => ({ recordOutputGuardEvents: vi.fn() }));

const FALLBACK = "I received your message but couldn't generate a proper response. Please try again.";
const PHASE_52_KEYS = ['RAG_OUTPUT_GUARD', 'RAG_REGISTRY_TEXTS', 'RAG_SECURITY_EVENTS', 'RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'];
const fetchMock = vi.fn();

beforeEach(() => {
  h.calls.length = 0;
  h.admin = fakeSupabaseAdmin(h.calls as AdminCall[]);
  h.sendTextMessage.mockReset();
  h.sendTextMessage.mockResolvedValue({ messageId: 'outgoing-1', status: 'sent' });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  for (const key of PHASE_52_KEYS) vi.stubEnv(key, '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sse(parts: unknown[], done = true): string {
  return parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
}

async function reply(chunks: string[], userText = 'What does the synthetic note say?'): Promise<string> {
  fetchMock.mockResolvedValueOnce(new Response(bodyFromChunks(chunks), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const { WhatsAppWebhookHandler } = await import('@/lib/whatsapp/webhook-handler');
  await new WhatsAppWebhookHandler().handleWebhook(messageWebhook(userText) as never);
  return h.sendTextMessage.mock.calls.map((call) => String(call[2])).join('');
}

function storedAssistantText(): string | undefined {
  const update = h.calls.filter((call) => call.table === 'chats' && call.op === 'update').pop();
  const messages = (update?.args[0] as { messages?: Array<{ role: string; content: string }> } | undefined)?.messages ?? [];
  return messages.filter((message) => message.role === 'assistant').pop()?.content;
}

describe('WhatsApp handler reads the chat route UI message stream', () => {
  it('sends the streamed text of the real streamText SSE body', async () => {
    const body = await chatRouteSseBody(['The synthetic note ', 'lists three items.']);
    expect(await reply([body])).toBe('The synthetic note lists three items.');
    expect(storedAssistantText()).toBe('The synthetic note lists three items.');
  });

  it('keeps the text when the body is split mid-line across chunks', async () => {
    const body = await chatRouteSseBody(['Alpha beta ', 'gamma delta.']);
    const cut = body.indexOf('"delta":"gamma') + 5;
    expect(await reply([body.slice(0, cut), body.slice(cut, cut + 3), body.slice(cut + 3)])).toBe('Alpha beta gamma delta.');
  });

  it('accepts CRLF line endings and no space after data:', async () => {
    const body = 'data:{"type":"text-delta","id":"t","delta":"First "}\r\n\r\ndata:{"type":"text-delta","id":"t","delta":"line."}\r\n\r\ndata:[DONE]\r\n';
    expect(await reply([body])).toBe('First line.');
  });

  it('ignores tool, metadata and error parts, and anything after [DONE]', async () => {
    const body = sse([
      { type: 'start', messageMetadata: { answerId: 'a-1' } },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c-1', toolName: 'webSearch', input: { query: 'synthetic' } },
      { type: 'tool-output-available', toolCallId: 'c-1', output: { results: [{ url: 'https://web.example.net/a', title: 'A' }] } },
      { type: 'data-source_images', data: [{ url: 'https://img.example.net/x.png' }] },
      { type: 'text-start', id: 't-1' },
      { type: 'text-delta', id: 't-1', delta: 'Only ' },
      { type: 'text-delta', id: 't-1', delta: 'this text.' },
      { type: 'text-end', id: 't-1' },
      { type: 'finish', messageMetadata: { truncated: false } },
    ]) + sse([{ type: 'text-delta', id: 't-1', delta: ' Late text.' }], false);
    expect(await reply([body])).toBe('Only this text.');
  });

  it('joins text parts by id in order of first appearance', async () => {
    const body = sse([
      { type: 'text-delta', id: 'a', delta: 'One ' },
      { type: 'text-delta', id: 'b', delta: 'three.' },
      { type: 'text-delta', id: 'a', delta: 'two ' },
    ]);
    expect(await reply([body])).toBe('One two three.');
  });

  it('still reads the legacy 0:"text" line format', async () => {
    expect(await reply(['0:"Legacy "\n0:"reply with \\"quotes\\"\\nand a newline."\n'])).toBe('Legacy reply with "quotes"\nand a newline.');
  });

  it('sends the fallback sentence for an empty or broken stream', async () => {
    expect(await reply([''])).toBe(FALLBACK);
    h.sendTextMessage.mockClear();
    expect(await reply(['data: {"type":"text-delta","id":"t","delta":\n\ndata: not json\n\ndata: [DONE]\n\n'])).toBe(FALLBACK);
  });
});

describe('WhatsApp guard pass uses the facts surfaced from the stream', () => {
  beforeEach(() => vi.stubEnv('RAG_OUTPUT_GUARD', 'enforce'));

  const webTurn = (metadata: Record<string, unknown> = {}) =>
    sse([
      { type: 'tool-input-start', toolCallId: 'c-1', toolName: 'webSearch' },
      { type: 'tool-output-available', toolCallId: 'c-1', output: { results: [{ url: 'https://web.example.net/result-one' }] } },
      { type: 'tool-input-available', toolCallId: 'c-2', toolName: 'otherTool', input: {} },
      { type: 'tool-output-available', toolCallId: 'c-2', output: { results: [{ url: 'https://other.example.net/tool' }] } },
      {
        type: 'text-delta',
        id: 't',
        delta: 'See https://web.example.net/result-one and https://meta.example.net/two and https://other.example.net/tool and https://outside.example.net/x for more.',
      },
      { type: 'finish', messageMetadata: { webSearch: { toolCallId: 'c-1', results: [{ url: 'https://meta.example.net/two' }] }, ...metadata } },
    ]);

  it('keeps links of the turn webSearch results (allow rule 2) and replaces other links', async () => {
    const text = await reply([webTurn()]);
    const placeholder = fixedText('notices.link_removed', 'en');
    expect(text).toContain('https://web.example.net/result-one');
    expect(text).toContain('https://meta.example.net/two');
    expect(text).not.toContain('https://other.example.net/tool');
    expect(text).not.toContain('https://outside.example.net/x');
    expect(text).toContain(placeholder);
  });

  it('treats web results as untrusted when the turn context was flagged', async () => {
    const text = await reply([webTurn({ injectionFlagged: true })]);
    expect(text).not.toContain('https://web.example.net/result-one');
    expect(text).not.toContain('https://meta.example.net/two');
  });

  it('writes the placeholder in the streamed answer language when it is a supported language', async () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    const italian = fixedText('notices.link_removed', 'it');
    expect(italian).not.toBe(fixedText('notices.link_removed', 'en'));
    expect(await reply([webTurn({ answerLanguage: 'it' })])).toContain(italian);
  });

  it('ignores an answer language outside the supported set', async () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    expect(await reply([webTurn({ answerLanguage: 'xx' })])).toContain(fixedText('notices.link_removed', 'en'));
  });
});
