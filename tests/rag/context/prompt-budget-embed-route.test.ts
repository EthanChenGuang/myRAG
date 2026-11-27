import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fixedText } from '@/lib/rag/lang/texts';
import { installChatPipeline, retrievalWith } from '../../helpers/chat-route-fakes';

const QUESTION = 'Which panel shows the export option?';
const CHUNK_TEXT = 'The export option is shown in the settings panel.';
const SMALL_MODEL = 'test/small-window';
const SMALL_WINDOW = 8000;

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const model = () =>
    new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'ok' },
          { type: 'text-end' as const, id: 't1' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      }),
    });
  return {
    ...fakes.createChatRouteHarness(),
    model,
    calls: [] as Array<Record<string, any>>,
    retrievalInputs: [] as Array<Record<string, any>>,
    traces: [] as Array<{ stages: () => Array<Record<string, any>> }>,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: (params: Parameters<typeof actual.streamText>[0]) => {
      h.calls.push(params as unknown as Record<string, any>);
      return actual.streamText({ ...params, model: h.model() });
    },
  };
});
vi.mock('@/lib/rag/trace/collector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/collector')>();
  return {
    ...actual,
    createTraceCollector: (options: Parameters<typeof actual.createTraceCollector>[0]) => {
      const collector = actual.createTraceCollector(options);
      h.traces.push(collector as never);
      return collector;
    },
  };
});
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));

const PROCESS_ENV: Record<string, string> = {
  NEXT_PUBLIC_EMBED_ENABLED: 'true',
  NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS: '*',
  NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
  EMBED_RATE_LIMIT: '100000',
  NEXT_PUBLIC_OPENROUTER_MODELS: JSON.stringify([{ id: SMALL_MODEL, displayName: 'Small window test model', contextLength: SMALL_WINDOW }]),
};
const SWITCHES = [
  'RAG_PROMPT_BUDGET',
  'RAG_CONTEXT_OVERFLOW',
  'RAG_CONTEXT_TOKEN_BUDGET',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_CALC_TOOL',
  'RAG_CALC_CHECK',
  'RAG_PIPELINE',
] as const;
const env = process.env as Record<string, string | undefined>;

type Message = { role: 'user' | 'assistant'; content: string };

function filler(label: string, words: number): string {
  return `${label}: ${'synthetic filler word '.repeat(words)}`.trim();
}

/** Three earlier turns of similar size, oldest first, then the question. */
function longConversation(): Message[] {
  const turns: Message[] = [];
  for (const n of [1, 2, 3]) {
    turns.push({ role: 'user', content: filler(`earlier question ${n}`, 330) });
    turns.push({ role: 'assistant', content: `earlier answer ${n}` });
  }
  return [...turns, { role: 'user', content: QUESTION }];
}

function seed() {
  h.supabase.store.documents = [{ id: 'doc-budget-1', filename: 'panel.txt', created_at: '2026-01-01T00:00:00.000Z', content: CHUNK_TEXT, metadata: {} }];
  h.supabase.store.document_chunks = [{ id: 'chunk-budget-1', document_id: 'doc-budget-1', content: CHUNK_TEXT, metadata: {} }];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-budget-1',
        document_id: 'doc-budget-1',
        content: CHUNK_TEXT,
        similarity: 0.9,
        metadata: {},
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.9,
        match_reason: 'similarity',
      },
    ]),
  );
}

async function post(messages: Message[] = [{ role: 'user', content: QUESTION }], model?: string) {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.retrievalInputs.push(input as unknown as Record<string, any>);
        return actual.runRetrieval(input);
      },
    };
  });
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/embed/chat/route');
  const response = await POST(
    new NextRequest('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.42', 'accept-language': 'en-US' },
      body: JSON.stringify({ messages, ...(model ? { model } : {}) }),
    }),
  );
  return response.text();
}

function errorTextOf(body: string): string | null {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const part = JSON.parse(payload) as { type?: string; errorText?: string };
      if (part.type === 'error' && typeof part.errorText === 'string') return part.errorText;
    } catch {
      continue;
    }
  }
  return null;
}

function budgetSpan() {
  return h.traces.flatMap((t) => t.stages()).find((s) => s.name === 'prompt_budget');
}

function sentMessages(): Array<{ role: string; content: string }> {
  return h.calls[0].messages as Array<{ role: string; content: string }>;
}

describe('embed route prompt budget (05.2.1-22)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [name, value] of Object.entries(PROCESS_ENV)) {
      saved[name] = env[name];
      env[name] = value;
    }
    for (const name of SWITCHES) {
      saved[name] = env[name];
      delete env[name];
    }
    h.calls.length = 0;
    h.retrievalInputs.length = 0;
    h.traces.length = 0;
    h.retrieval.mockReset();
    seed();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    vi.restoreAllMocks();
  });

  it('switch off: no document budget, no provider options, every client turn sent as today', async () => {
    const conversation = longConversation();
    await post(conversation, SMALL_MODEL);

    expect(h.retrievalInputs).toHaveLength(1);
    expect(h.retrievalInputs[0].options?.documentTokenBudget).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].providerOptions).toBeUndefined();
    expect(h.calls[0].maxOutputTokens).toBe(2000);
    expect(sentMessages().slice(1)).toEqual(conversation);
    expect(budgetSpan()).toBeUndefined();
  });

  it('switch on: the document budget goes to retrieval, compression is off on OpenRouter, the question is last and the span is recorded', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    await post([{ role: 'user', content: QUESTION }], SMALL_MODEL);

    const budget = h.retrievalInputs[0].options?.documentTokenBudget;
    expect(typeof budget).toBe('number');
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(6000);
    expect(h.calls[0].providerOptions?.openrouter?.plugins).toEqual([{ id: 'context-compression', enabled: false }]);
    const messages = sentMessages();
    expect(messages.at(-1)).toEqual({ role: 'user', content: QUESTION });
    const span = budgetSpan();
    expect(span?.status).toBe('ok');
    expect(span?.counts).toMatchObject({ reserve: 2000, documents: expect.any(Number) });
    expect(span?.attributes).toMatchObject({ window: SMALL_WINDOW, window_source: 'model', overflow_mode: 'truncate' });
  });

  it('switch on: the document budget never exceeds RAG_CONTEXT_TOKEN_BUDGET', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    env.RAG_CONTEXT_TOKEN_BUDGET = '500';
    await post();

    expect(h.retrievalInputs[0].options?.documentTokenBudget).toBe(500);
  });

  it('switch on: the answer reserve is the smaller of the fixed limit and the Phase 5.2 cap when it applies', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    await post([{ role: 'user', content: QUESTION }], SMALL_MODEL);
    const uncapped = budgetSpan();
    const uncappedBudget = h.retrievalInputs[0].options?.documentTokenBudget as number;
    expect(uncapped?.counts?.reserve).toBe(2000);

    h.calls.length = 0;
    h.retrievalInputs.length = 0;
    h.traces.length = 0;
    env.RAG_MAX_OUTPUT_TOKENS = '512';
    await post([{ role: 'user', content: QUESTION }], SMALL_MODEL);

    expect(budgetSpan()?.counts?.reserve).toBe(512);
    expect(h.calls[0].maxOutputTokens).toBe(512);
    expect(h.retrievalInputs[0].options?.documentTokenBudget as number).toBeGreaterThan(uncappedBudget);
  });

  it('switch on: history is trimmed oldest-first in whole turns and the question stays last', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    env.RAG_CONTEXT_TOKEN_BUDGET = '1000';
    const conversation = longConversation();
    await post(conversation, SMALL_MODEL);

    const sent = sentMessages().slice(1);
    expect(sent.at(-1)).toEqual({ role: 'user', content: QUESTION });
    const history = conversation.slice(0, -1);
    const keptHistory = sent.slice(0, -1);
    expect(keptHistory.length).toBeGreaterThan(0);
    expect(keptHistory.length).toBeLessThan(history.length);
    expect(keptHistory.length % 2).toBe(0);
    expect(keptHistory).toEqual(history.slice(history.length - keptHistory.length));
    expect(budgetSpan()?.counts?.dropped_history_turns).toBe((history.length - keptHistory.length) / 2);
  });

  it('RAG_CONTEXT_OVERFLOW=refine never applies to embed: the request equals the truncate run', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    env.RAG_CONTEXT_TOKEN_BUDGET = '1000';
    const conversation = longConversation();
    await post(conversation, SMALL_MODEL);
    const truncateMessages = sentMessages();
    const truncateBudget = h.retrievalInputs[0].options?.documentTokenBudget;

    h.calls.length = 0;
    h.retrievalInputs.length = 0;
    h.traces.length = 0;
    env.RAG_CONTEXT_OVERFLOW = 'refine';
    await post(conversation, SMALL_MODEL);

    expect(h.calls).toHaveLength(1);
    expect(sentMessages()).toEqual(truncateMessages);
    expect(h.retrievalInputs[0].options?.documentTokenBudget).toBe(truncateBudget);
    expect(budgetSpan()?.attributes?.overflow_mode).toBe('truncate');
  });

  it('switch on with an oversized question: in-band prompt_too_long error, no retrieval and no model call', async () => {
    env.RAG_PROMPT_BUDGET = 'true';
    const body = await post([{ role: 'user', content: filler('oversized question', 4000) }], SMALL_MODEL);

    expect(errorTextOf(body)).toBe(fixedText('notices.prompt_too_long', 'en'));
    expect(h.retrievalInputs).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    expect(body).not.toContain('synthetic filler');
  });
});
