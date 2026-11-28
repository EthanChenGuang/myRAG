import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/lib/env';
import { AnswerRecordSchema } from '@/lib/rag-eval/contracts.generated';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const SESSION_USER = '00000000-0000-4000-8000-0000000018c1';
const QUESTION = 'What is the refund window for annual plans?';
const GPT_PATTERN = /gpt-4|o1|chatgpt/;

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import('ai/test');
  const model = (modelId: string) =>
    new MockLanguageModelV3({
      modelId,
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          { type: 'text-start' as const, id: 't1' },
          { type: 'text-delta' as const, id: 't1', delta: 'Annual plans have a refund window [S1].' },
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
      }),
    });
  const session = { userId: null as string | null };
  return {
    model,
    session,
    tasks: [] as Array<() => Promise<void>>,
    rows: new Map<string, unknown>(),
    sidecarUrl: { value: '' },
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) } },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => h.model(modelId),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));
vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));
vi.mock('@/lib/answers/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/answers/store')>()),
  insertAnswerRecord: async (_admin: unknown, input: { id: string; groundedness: unknown }) => {
    h.rows.set(input.id, input.groundedness);
    return { inserted: true };
  },
  updateAnswerGroundedness: async (_admin: unknown, input: { id: string; groundedness: unknown }) => {
    h.rows.set(input.id, input.groundedness);
    return true;
  },
}));
vi.mock('@/lib/rag/generation/groundedness-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rag/generation/groundedness-client')>();
  return {
    ...original,
    requestGroundedness: (request: Parameters<typeof original.requestGroundedness>[0], options: Parameters<typeof original.requestGroundedness>[1] = {}) =>
      original.requestGroundedness(request, { ...options, url: h.sidecarUrl.value, secret: 'sidecar-secret-placeholder' }),
  };
});

function nonGptModel(): string {
  const models = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  const id = models.map((model) => model.id).find((candidate) => !GPT_PATTERN.test(candidate) && !candidate.includes('claude'));
  if (!id) throw new Error('no non-GPT fixture model configured');
  return id;
}

function answerIdOf(body: string): string {
  const match = /"answerId":"([0-9a-f-]{36})"/.exec(body);
  if (!match) throw new Error('no answerId in the stream');
  return match[1];
}

describe('chat route: groundedness runs after the response', () => {
  let fixture: RouteFixture;
  let model: string;
  let sidecar: http.Server;
  let sidecarRequests = 0;
  const held: http.ServerResponse[] = [];

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
    model = nonGptModel();
    sidecar = http.createServer((_req, res) => {
      sidecarRequests += 1;
      held.push(res);
    });
    await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', () => resolve()));
    h.sidecarUrl.value = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const res of held) res.destroy();
    sidecar.closeAllConnections();
    await new Promise<void>((resolve) => sidecar.close(() => resolve()));
    await fixture.close();
  });

  beforeEach(() => {
    h.tasks.length = 0;
    h.rows.clear();
    sidecarRequests = 0;
    h.session.userId = SESSION_USER;
    h.exa.reset();
    process.env.RAG_GROUNDEDNESS = 'true';
    process.env.RAG_GROUNDEDNESS_TIMEOUT_MS = '50';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.RAG_GROUNDEDNESS;
    delete process.env.RAG_GROUNDEDNESS_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('completes the SSE response before the sidecar is called, and the row later reads not_checked timeout', async () => {
    const { POST } = await fixture.loadRoute<{ POST: (req: Request) => Promise<Response> }>('chat');
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: QUESTION }],
        data: { ragMode: 'strict', settings: { model, webSearch: false }, capabilities: { citations: true } },
      }),
    );
    const body = await response.text();
    expect(body).toContain('[DONE]');
    const answerId = answerIdOf(body);
    expect(sidecarRequests).toBe(0);
    expect(h.rows.has(answerId)).toBe(false);

    for (const task of h.tasks.splice(0)) await task();

    expect(sidecarRequests).toBe(1);
    const stored = AnswerRecordSchema.shape.groundedness.parse(h.rows.get(answerId));
    expect(stored).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'timeout', scorer: 'none' });
  });
});
