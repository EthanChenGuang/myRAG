import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { CitationRecordSchema } from '@/lib/rag-eval/contracts.generated';
import type { AnswerFinishInput } from '@/lib/rag/generation/answer-finish';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const SESSION_USER = '00000000-0000-4000-8000-00000000a113';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['ok'] as string[], hang: false };
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async () => {
        const parts = [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          ...state.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
        ];
        if (state.hang) {
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part);
              },
            }),
          };
        }
        return {
          stream: convertArrayToReadableStream([
            ...parts,
            { type: 'text-end' as const, id: 't1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ]),
        };
      },
    });
  const session = { userId: null as string | null };
  return {
    state,
    model,
    session,
    scheduled: [] as unknown[],
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) } },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => h.model(modelId),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag/generation/answer-finish', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rag/generation/answer-finish')>()),
  scheduleAnswerFinish: (input: unknown) => {
    h.scheduled.push(input);
  },
}));

const QUESTION = 'What is the refund window for annual plans?';
const IMAGE_QUESTION = 'Which aisles hold thermal probes according to the floor plan?';
const GPT_PATTERN = /gpt-4|o1|chatgpt/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SWITCHES = ['RAG_CITATIONS', 'RAG_CLAUDE_CITATIONS', 'RAG_GROUNDEDNESS', 'RAG_ANSWER_FEEDBACK'] as const;

function nonGptModel(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  const id = models.map((model) => model.id).find((candidate) => !GPT_PATTERN.test(candidate) && !candidate.includes('claude'));
  if (!id) throw new Error('no non-GPT fixture model configured');
  return id;
}

interface SseChunk {
  type?: string;
  delta?: string;
  messageMetadata?: Record<string, unknown>;
}

function parseSse(body: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(payload) as SseChunk);
    } catch {
      continue;
    }
  }
  return chunks;
}

function normalizeIds(body: string): string {
  return body.replace(/"(id|messageId|toolCallId|ragTraceId)":"[^"]*"/g, '"$1":"<id>"');
}

function streamedText(chunks: SseChunk[]): string {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta ?? '').join('');
}

function metadataOf(chunks: SseChunk[], type: string): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === type)?.messageMetadata;
}

function scheduledInputs(): AnswerFinishInput[] {
  return h.scheduled as AnswerFinishInput[];
}

describe('chat route answerId and the post-stream answer record', () => {
  let fixture: RouteFixture;
  let model: string;

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    model = nonGptModel();
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.scheduled.length = 0;
    h.state.deltas = ['ok'];
    h.state.hang = false;
    h.session.userId = SESSION_USER;
    h.exa.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of SWITCHES) delete process.env[name];
  });

  async function postRaw(data: Record<string, unknown>, content = QUESTION) {
    const { POST } = await fixture.loadRoute<{ POST: (req: Request) => Promise<Response> }>('chat');
    const response = await POST(chatRequest({ messages: [{ role: 'user', content }], data }));
    return response.text();
  }

  async function post(data: Record<string, unknown>, content = QUESTION) {
    return parseSse(await postRaw(data, content));
  }

  const webChat = () => ({ ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } });

  it('sends one answerId in the start and finish metadata and schedules one record with the streamed text and the full citations', async () => {
    process.env.RAG_CITATIONS = 'true';
    h.state.deltas = ['Annual plans [S', '1] have a window.'];
    const chunks = await post(webChat());

    const start = metadataOf(chunks, 'start');
    const finish = metadataOf(chunks, 'finish');
    expect(start?.answerId).toMatch(UUID_RE);
    expect(finish?.answerId).toBe(start?.answerId);
    expect(Object.keys(start ?? {})).toEqual(['ragTraceId', 'answerId']);
    expect(finish?.ragTraceId).toBe(start?.ragTraceId);

    expect(scheduledInputs()).toHaveLength(1);
    const scheduled = scheduledInputs()[0];
    expect(scheduled.answerId).toBe(start?.answerId);
    expect(scheduled.answerText).toBe(streamedText(chunks));
    expect(scheduled.answerText).toBe('Annual plans [S1] have a window.');
    expect(scheduled.userId).toBe(SESSION_USER);
    expect(scheduled.traceId).toBe(start?.ragTraceId);
    expect(scheduled.modelId).toBe(model);
    expect(scheduled.ragMode).toBe('strict');
    expect(scheduled.queryText).toBe(QUESTION);
    expect(scheduled.citationStrategy).toBe('chunk-alias');
    expect(scheduled.invalidCitations).toBe(0);
    expect(scheduled.aborted).toBe(false);
    expect(scheduled.groundednessEligible).toBe(true);
    expect(scheduled.toolOutputUsed).toBe(false);
    expect(scheduled.requestLanguage).toBe('en');
    expect(scheduled.premise.blocks.length).toBeGreaterThan(0);
    expect(scheduled.premise.blocks[0].alias).toBe('S1');
    expect(scheduled.premise.webSearchTexts).toEqual([]);

    const metaCitations = z.array(CitationRecordSchema).parse(finish?.citations);
    const full = z.array(CitationRecordSchema).parse(scheduled.citations);
    expect(full.map((c) => c.alias)).toEqual(['S1']);
    expect(full[0].quoteHash).toBe(metaCitations[0].quoteHash);
    expect(full[0].quote.startsWith(metaCitations[0].quote)).toBe(true);
    expect(full[0].quote).toBe(scheduled.premise.blocks[0].text);
  });

  it('mints a new answerId per request', async () => {
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    const first = metadataOf(await post(webChat()), 'start')?.answerId;
    const second = metadataOf(await post(webChat()), 'start')?.answerId;
    expect(first).toMatch(UUID_RE);
    expect(second).toMatch(UUID_RE);
    expect(first).not.toBe(second);
    expect(scheduledInputs().map((input) => input.answerId)).toEqual([first, second]);
    expect(scheduledInputs()[0].citationStrategy).toBeNull();
    expect(scheduledInputs()[0].citations).toEqual([]);
  });

  it('carries the answerId in the finish metadata on the source_images path, which sends no start', async () => {
    process.env.RAG_CITATIONS = 'true';
    const body = await postRaw(webChat(), IMAGE_QUESTION);
    expect(body).toContain('source_images');
    const chunks = parseSse(body);
    expect(chunks.some((chunk) => chunk.type === 'start')).toBe(false);
    const finish = metadataOf(chunks, 'finish');
    expect(finish?.answerId).toMatch(UUID_RE);
    expect(scheduledInputs()).toHaveLength(1);
    expect(scheduledInputs()[0].answerId).toBe(finish?.answerId);
  });

  it('marks a balanced turn eligible and a flexible turn not eligible', async () => {
    process.env.RAG_GROUNDEDNESS = 'true';
    await post({ ...webChat(), ragMode: 'balanced' });
    await post({ ...webChat(), ragMode: 'flexible' });
    expect(scheduledInputs().map((input) => [input.ragMode, input.groundednessEligible])).toEqual([
      ['balanced', true],
      ['flexible', false],
    ]);
  });

  describe('no answerId and no record, byte-identical to every switch off', () => {
    async function offBody(data: Record<string, unknown>) {
      for (const name of SWITCHES) delete process.env[name];
      return normalizeIds(await postRaw(data));
    }

    function switchesOn() {
      for (const name of SWITCHES) process.env[name] = 'true';
    }

    it('for a ghost chat', async () => {
      const data = { ...webChat(), chatId: 'ghost-1234' };
      h.state.deltas = ['Answer.'];
      process.env.RAG_CITATIONS = 'false';
      const off = await offBody(data);
      process.env.RAG_GROUNDEDNESS = 'true';
      process.env.RAG_ANSWER_FEEDBACK = 'true';
      const on = normalizeIds(await postRaw(data));
      expect(on).toBe(off);
      expect(on).not.toContain('answerId');
      expect(h.scheduled).toHaveLength(0);
    });

    it('for a ghost chat with citations on (citations still sent, nothing persisted)', async () => {
      process.env.RAG_CITATIONS = 'true';
      h.state.deltas = ['Answer [S1].'];
      const body = await postRaw({ ...webChat(), chatId: 'ghost-1234' });
      expect(body).toContain('citationStrategy');
      expect(body).not.toContain('answerId');
      expect(h.scheduled).toHaveLength(0);
    });

    it('for a request without a session user', async () => {
      h.session.userId = null;
      const off = await offBody(webChat());
      switchesOn();
      process.env.RAG_CITATIONS = 'false';
      process.env.RAG_CLAUDE_CITATIONS = 'false';
      const on = normalizeIds(await postRaw(webChat()));
      expect(on).toBe(off);
      expect(on).not.toContain('answerId');
      expect(h.scheduled).toHaveLength(0);
    });

    it('for a request without capabilities (the WhatsApp body)', async () => {
      const data = { ragMode: 'strict', settings: { model, webSearch: false } };
      const off = await offBody(data);
      switchesOn();
      const on = normalizeIds(await postRaw(data));
      expect(on).toBe(off);
      expect(on).not.toContain('answerId');
      expect(h.scheduled).toHaveLength(0);
    });

    it('for a request with every switch off', async () => {
      const body = await postRaw(webChat());
      expect(body).not.toContain('answerId');
      expect(h.scheduled).toHaveLength(0);
    });

    it('for the strict refusal', async () => {
      process.env.RAG_ANSWER_FEEDBACK = 'true';
      const body = await postRaw(webChat(), 'zzqx vrrp kkwt');
      expect(body).not.toContain('answerId');
      expect(h.scheduled).toHaveLength(0);
    });
  });

  it('schedules one task with aborted true when the client aborts', async () => {
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    h.state.hang = true;
    h.state.deltas = ['Partial answer'];
    const controller = new AbortController();
    const { POST } = await fixture.loadRoute<{ POST: (req: Request) => Promise<Response> }>('chat');
    const request = chatRequest({ messages: [{ role: 'user', content: QUESTION }], data: webChat() });
    const response = await POST(new Request(request, { signal: controller.signal }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('Partial answer')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    controller.abort();
    await reader.cancel();
    await vi.waitFor(() => expect(h.scheduled).toHaveLength(1));
    const scheduled = scheduledInputs()[0];
    expect(scheduled.aborted).toBe(true);
    expect(scheduled.answerText).toBe('Partial answer');
    expect(seen).toContain(scheduled.answerId);
  });
});
