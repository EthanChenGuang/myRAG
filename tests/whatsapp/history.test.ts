import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../eval/harness/fake-query-llm.mts';
import { emptyRetrieval, installChatPipeline } from '../helpers/chat-route-fakes';
import {
  GROUP_JID,
  SENDER_A,
  SENDER_B,
  SESSION_A,
  SESSION_B,
  createWhatsAppHarness,
  inboundText,
  settleTitles,
  type RoutePost,
} from './harness';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

const route = vi.hoisted(() => ({ post: null as null | ((request: Request) => Promise<Response>) }));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/title-generator', () => ({ generateTitle: vi.fn(() => 'Synthetic chat'), generateSmartTitle: vi.fn(async () => 'Synthetic chat') }));
vi.mock('@/lib/whatsapp/session-manager', () => ({ getSessionManager: () => ({}) }));
vi.mock('@/lib/whatsapp/client-factory', () => ({ getWhatsAppClient: () => ({}) }));

const LAYER_ON = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true' };
const FIRST = 'Tell me about the alpha setting.';
const FOLLOW_UP = 'What is its upper limit?';
const STANDALONE = 'What is the upper limit of the alpha setting?';
const ANSWER = 'The alpha setting is described in the synthetic guide.';

const harness = createWhatsAppHarness({ post: () => route.post as RoutePost });
const fakeLlm = createFakeQueryLlm({
  table: { version: 1, entries: [{ transform: 'condense', query: FOLLOW_UP, output: { standalone: STANDALONE, unchanged: false, language: null } }] },
});

async function loadChat(ragEnv?: Record<string, string>) {
  vi.resetModules();
  await installChatPipeline(h);
  const deps = await import('@/lib/rag/deps');
  if (ragEnv) {
    deps.setRagDepsForTests({ ragEnv: () => ragEnv, queryLlm: () => fakeLlm });
    const startup = await import('@/lib/rag/v2/startup');
    await startup.verifyV2Startup();
  }
  const chat = await import('@/app/api/chat/route');
  route.post = chat.POST as unknown as (request: Request) => Promise<Response>;
  const { WhatsAppWebhookHandler } = await import('@/lib/whatsapp/webhook-handler');
  return new WhatsAppWebhookHandler(harness.deps as never);
}

type Handler = Awaited<ReturnType<typeof loadChat>>;

async function say(handler: Handler, text: string, options: { sessionId?: string; from?: string } = {}) {
  await handler.handleWebhook(inboundText(text, options) as never);
  settleTitles(harness);
}

function lastRequestMessages(): Array<Record<string, any>> {
  const request = harness.chatRequests.at(-1);
  if (!request) throw new Error('no chat request');
  return request.body.messages as Array<Record<string, any>>;
}

beforeEach(() => {
  harness.reset();
  h.capture.reset();
  h.capture.setDeltas([ANSWER]);
  h.retrieval.mockReset();
  h.retrieval.mockResolvedValue(emptyRetrieval());
  fakeLlm.calls.length = 0;
  vi.stubEnv('RAG_BEHAVIOR_MODE', 'balanced');
  vi.stubEnv('RAG_WHATSAPP_HISTORY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('WhatsApp handler against the chat route in process', () => {
  it('one inbound message is answered with the streamed text through the fake client', async () => {
    const handler = await loadChat();
    await say(handler, FIRST);
    expect(harness.chatRequests).toHaveLength(1);
    expect(harness.chatRequests[0].status).toBe(200);
    expect(harness.sent.map((message) => message.text).join('')).toContain(ANSWER);
    expect(harness.sent[0]).toMatchObject({ sessionId: SESSION_A, to: SENDER_A });
  });

  it('switch off: every chat request carries only the current message and nothing is stamped', async () => {
    const handler = await loadChat(LAYER_ON);
    await say(handler, FIRST);
    await say(handler, FOLLOW_UP);
    expect(lastRequestMessages()).toHaveLength(1);
    expect(lastRequestMessages()[0].content).toBe(FOLLOW_UP);
    const stored = harness.messagesOf(SENDER_A);
    expect(stored).toHaveLength(4);
    expect(stored.every((message) => (message.metadata as any)?.whatsapp === undefined)).toBe(true);
  });
});

describe('WhatsApp history behind RAG_WHATSAPP_HISTORY (D-24, P-24)', () => {
  beforeEach(() => {
    vi.stubEnv('RAG_WHATSAPP_HISTORY', 'true');
  });

  it('the follow-up carries the windowed turns and is condensed into a standalone query', async () => {
    const handler = await loadChat(LAYER_ON);
    await say(handler, FIRST);
    await say(handler, FOLLOW_UP);
    const messages = lastRequestMessages();
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', FIRST],
      ['assistant', ANSWER],
      ['user', FOLLOW_UP],
    ]);
    expect(fakeLlm.calls.some((call) => call.transform === 'condense' && call.input === FOLLOW_UP)).toBe(true);
    const storedFollowUp = harness.messagesOf(SENDER_A)[2] as Record<string, any>;
    expect(storedFollowUp.metadata.rag.standaloneQuery).toBe(STANDALONE);
    expect(storedFollowUp.metadata.rag.standaloneQuery).not.toBe(FOLLOW_UP);
  });

  it('stores the streamed rag metadata on the user turn and stamps both turns with session and sender', async () => {
    const handler = await loadChat(LAYER_ON);
    await say(handler, FIRST);
    const [user, assistant] = harness.messagesOf(SENDER_A) as Array<Record<string, any>>;
    expect(user.metadata).toBeDefined();
    expect(user.metadata.rag).toEqual({ standaloneQuery: FIRST, queryLanguage: expect.anything() });
    expect(user.metadata.whatsapp).toEqual({ sessionId: SESSION_A, senderJid: SENDER_A });
    expect(assistant.metadata.whatsapp).toEqual({ sessionId: SESSION_A, senderJid: SENDER_A });
    expect(assistant.metadata.rag).toBeUndefined();
  });

  it('two senders of one owner never see each other’s turns', async () => {
    const handler = await loadChat(LAYER_ON);
    await say(handler, FIRST, { from: SENDER_A });
    await say(handler, FOLLOW_UP, { from: SENDER_B });
    expect(lastRequestMessages()).toHaveLength(1);
    expect(JSON.stringify(lastRequestMessages())).not.toContain(FIRST);
  });

  it('one sender in two sessions gets only the history of the current session', async () => {
    const handler = await loadChat(LAYER_ON);
    await say(handler, FIRST, { sessionId: SESSION_A });
    await say(handler, FOLLOW_UP, { sessionId: SESSION_B });
    expect(lastRequestMessages()).toHaveLength(1);
    await say(handler, FOLLOW_UP, { sessionId: SESSION_A });
    const messages = lastRequestMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe(FIRST);
  });

  it('a group JID gets no history', async () => {
    const handler = await loadChat(LAYER_ON);
    await say(handler, FIRST, { from: GROUP_JID });
    await say(handler, FOLLOW_UP, { from: GROUP_JID });
    expect(lastRequestMessages()).toHaveLength(1);
  });

  it('older unstamped turns are left out of the window', async () => {
    const handler = await loadChat();
    vi.stubEnv('RAG_WHATSAPP_HISTORY', '');
    await say(handler, FIRST);
    vi.stubEnv('RAG_WHATSAPP_HISTORY', 'true');
    await say(handler, FOLLOW_UP);
    expect(harness.messagesOf(SENDER_A)).toHaveLength(4);
    expect(lastRequestMessages()).toHaveLength(1);
  });

  for (const command of ['reset', 'new chat', '/reset']) {
    it(`"${command}" clears the stored turns, so the next request has no history`, async () => {
      const handler = await loadChat(LAYER_ON);
      await say(handler, FIRST);
      await say(handler, command);
      expect(harness.messagesOf(SENDER_A)).toEqual([]);
      const before = harness.chatRequests.length;
      await say(handler, FOLLOW_UP);
      expect(harness.chatRequests).toHaveLength(before + 1);
      expect(lastRequestMessages()).toHaveLength(1);
    });
  }
});

describe('buildWhatsAppHistory window (D-16 caps)', () => {
  it('keeps the last 6 turns, cuts each to 1000 characters and strips assistant sources and citation markers', async () => {
    const { buildWhatsAppHistory, stampWhatsAppMessage } = await import('@/lib/whatsapp/history');
    const stamp = { sessionId: SESSION_A, senderJid: SENDER_A };
    const stored = [] as Array<Record<string, unknown>>;
    for (let i = 0; i < 5; i += 1) {
      stored.push(stampWhatsAppMessage({ role: 'user', content: `Synthetic question ${i} ${'x'.repeat(1200)}` }, stamp));
      stored.push(stampWhatsAppMessage({ role: 'assistant', content: `Synthetic answer ${i} [S1].\n\nSources:\n- guide.md`, source_images: [{ url: 'https://example.test/a.png' }] }, stamp));
    }
    stored.push({ role: 'user', content: 'Unstamped synthetic question' });
    const window = buildWhatsAppHistory(stored, stamp);
    expect(window).toHaveLength(6);
    expect(window[0].content.startsWith('Synthetic question 2')).toBe(true);
    expect(window.every((turn) => Array.from(turn.content).length <= 1000)).toBe(true);
    const answers = window.filter((turn) => turn.role === 'assistant');
    expect(answers.map((turn) => turn.content)).toEqual(['Synthetic answer 2.', 'Synthetic answer 3.', 'Synthetic answer 4.']);
    expect(JSON.stringify(window)).not.toContain('source_images');
    expect(JSON.stringify(window)).not.toContain('Unstamped');
  });
});
