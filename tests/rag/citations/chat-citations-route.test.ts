import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { CitationRecordSchema } from '@/lib/rag-eval/contracts.generated';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const state = { deltas: ['ok'] as string[] };
  const calls: Array<{ prompt: Array<{ role: string; content: unknown }> }> = [];
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async (options) => {
        calls.push({ prompt: options.prompt as Array<{ role: string; content: unknown }> });
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 't1' },
            ...state.deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
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
  return {
    state,
    calls,
    model,
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => h.model(modelId),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const QUESTION = 'What is the refund window for annual plans?';
const GPT_PATTERN = /gpt-4|o1|chatgpt/;

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

function finishMetadata(chunks: SseChunk[]): Record<string, unknown> | undefined {
  return chunks.find((chunk) => chunk.type === 'finish')?.messageMetadata;
}

function systemPrompt(): string {
  const prompt = h.calls.at(-1)?.prompt ?? [];
  return prompt
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n\n');
}

describe('chat route with chunk-alias citations (tracer)', () => {
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
    h.calls.length = 0;
    h.state.deltas = ['ok'];
    h.exa.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.RAG_CITATIONS;
  });

  async function post(data: Record<string, unknown>) {
    const { POST } = await fixture.loadRoute('chat');
    const response = await POST(chatRequest({ messages: [{ role: 'user', content: QUESTION }], data }));
    return parseSse(await response.text());
  }

  it('labels the blocks, validates the streamed markers and sends CitationRecord[] in the finish metadata', async () => {
    process.env.RAG_CITATIONS = 'true';
    h.state.deltas = ['Answer [S', '1] and [S9].'];
    const chunks = await post({ ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } });

    expect(h.calls).toHaveLength(1);
    const system = systemPrompt();
    const firstLabel = system.search(/^\[S1\] /m);
    expect(firstLabel).toBeGreaterThan(-1);
    const instruction = system.indexOf('[S<number>]');
    expect(instruction).toBeGreaterThan(firstLabel);

    expect(streamedText(chunks)).toBe('Answer [S1] and [S9].');

    const metadata = finishMetadata(chunks);
    expect(metadata).toBeDefined();
    const citations = z.array(CitationRecordSchema).parse(metadata?.citations);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ n: 1, alias: 'S1', strategy: 'chunk-alias' });
    const s1Start = system.search(/^\[S1\] /m);
    const afterHeader = system.indexOf('\n', s1Start) + 1;
    expect(system.slice(afterHeader, afterHeader + citations[0].quote.length)).toBe(citations[0].quote);
    expect(citations[0].quoteHash).toBe(createHash('sha256').update(citations[0].quote).digest('hex'));
    expect(metadata?.citationStrategy).toBe('chunk-alias');
    expect(metadata?.invalidCitations).toBe(1);
  });

  it('with RAG_CITATIONS=false sends the same system prompt as a request without capabilities and no citations', async () => {
    process.env.RAG_CITATIONS = 'false';
    h.state.deltas = ['Answer [S1].'];
    const withCapability = await post({ ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } });
    const promptWith = systemPrompt();
    const withoutCapability = await post({ ragMode: 'strict', settings: { model, webSearch: false } });
    const promptWithout = systemPrompt();

    expect(promptWith).toBe(promptWithout);
    expect(promptWith).not.toMatch(/^\[S1\] /m);
    expect(finishMetadata(withCapability) ?? {}).not.toHaveProperty('citations');
    expect(finishMetadata(withoutCapability) ?? {}).not.toHaveProperty('citations');
    expect(streamedText(withCapability)).toBe('Answer [S1].');
  });

  it('with RAG_CITATIONS=true and no capabilities (the WhatsApp body) sends the same prompt and SSE body as with the switch off', async () => {
    h.state.deltas = ['Answer [S1].'];
    const body = { ragMode: 'strict', settings: { model, webSearch: false } };
    const run = async () => {
      const { POST } = await fixture.loadRoute('chat');
      const response = await POST(chatRequest({ messages: [{ role: 'user', content: QUESTION }], data: body }));
      return { sse: normalizeIds(await response.text()), system: systemPrompt() };
    };
    process.env.RAG_CITATIONS = 'false';
    const off = await run();
    process.env.RAG_CITATIONS = 'true';
    const on = await run();
    expect(on.system).toBe(off.system);
    expect(on.sse).toBe(off.sse);
    expect(on.sse).not.toContain('citationStrategy');
  });

  it('still sends citations for a ghost chat id', async () => {
    process.env.RAG_CITATIONS = 'true';
    h.state.deltas = ['Ghost answer [S1].'];
    const chunks = await post({
      chatId: 'ghost-1234',
      ragMode: 'strict',
      settings: { model, webSearch: false },
      capabilities: { citations: true },
    });
    const metadata = finishMetadata(chunks);
    expect(z.array(CitationRecordSchema).parse(metadata?.citations).map((c) => c.alias)).toEqual(['S1']);
  });

  it('treats an invalid capabilities value as absent', async () => {
    process.env.RAG_CITATIONS = 'true';
    h.state.deltas = ['Answer [S1].'];
    const chunks = await post({ ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: 'yes' } });
    expect(systemPrompt()).not.toMatch(/^\[S1\] /m);
    expect(finishMetadata(chunks) ?? {}).not.toHaveProperty('citations');
  });

  it('strips markers from earlier assistant turns before the model sees them when citations are active', async () => {
    const messages = [
      { role: 'user', content: 'Tell me about refunds.' },
      { role: 'assistant', content: 'Refunds are possible [S2] within a window [S4].' },
      { role: 'user', content: QUESTION },
    ];
    const assistantText = () =>
      (h.calls.at(-1)?.prompt ?? [])
        .filter((message) => message.role === 'assistant')
        .map((message) => JSON.stringify(message.content))
        .join('\n');
    const { POST } = await fixture.loadRoute('chat');

    process.env.RAG_CITATIONS = 'true';
    await (await POST(chatRequest({ messages, data: { ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } } }))).text();
    expect(assistantText()).toContain('Refunds are possible within a window.');
    expect(assistantText()).not.toContain('[S2]');

    process.env.RAG_CITATIONS = 'false';
    await (await POST(chatRequest({ messages, data: { ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } } }))).text();
    expect(assistantText()).toContain('Refunds are possible [S2] within a window [S4].');
  });
});
