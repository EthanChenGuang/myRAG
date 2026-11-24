import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { env as appEnv } from '@/lib/env';
import { chatRequest } from '../../helpers/chat-route-fakes';
import { readGoldenQuestions, startRouteFixture, systemTextOf, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const fakes = await import('../../helpers/chat-route-fakes');
  return {
    capture: fakes.createStreamTextCapture(),
    exa: fakes.createExaFake(),
    ssr: { auth: { getUser: async () => ({ data: { user: null }, error: null }) } },
    runSpy: vi.fn(),
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStreamResponse: () => new Response('model stream'),
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const env = process.env as Record<string, string | undefined>;
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const QUESTION = readGoldenQuestions()[0].question;

function chatModel(): string {
  const models = JSON.parse(appEnv.NEXT_PUBLIC_OPENROUTER_MODELS) as Array<{ id: string }>;
  const id = models.find((model) => !/gpt-4|o1|chatgpt/.test(model.id) && !model.id.includes('claude'))?.id;
  if (!id) throw new Error('no non-GPT model configured');
  return id;
}

function chatBody(extra: Record<string, unknown> = {}) {
  return chatRequest({
    messages: [{ role: 'user', content: QUESTION }],
    data: { ragMode: 'strict', settings: { webSearch: false, model: chatModel() } },
    ...extra,
  });
}

function embedBody(extra: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/embed/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify({ messages: [{ role: 'user', content: QUESTION }], ...extra }),
  });
}

type RetrievalInput = { profile: string; retrievalFilters?: unknown } & Record<string, unknown>;

function retrievalCalls(profile: string): RetrievalInput[] {
  return h.runSpy.mock.calls.map((call) => call[0] as RetrievalInput).filter((input) => input.profile === profile);
}

describe('retrievalFilters on the chat and embed bodies', () => {
  let fixture: RouteFixture;
  let savedPipeline: string | undefined;

  beforeAll(async () => {
    fixture = await startRouteFixture({ deploymentMode: 'single-tenant' });
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.runSpy.mockReset();
    savedPipeline = env.RAG_PIPELINE;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedPipeline === undefined) delete env.RAG_PIPELINE;
    else env.RAG_PIPELINE = savedPipeline;
    vi.doUnmock('@/lib/rag');
    vi.restoreAllMocks();
  });

  async function loadRoute(routePath: 'chat' | 'embed/chat', pipeline: string | undefined) {
    if (pipeline === undefined) delete env.RAG_PIPELINE;
    else env.RAG_PIPELINE = pipeline;
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
          h.runSpy(input);
          return actual.runRetrieval(input);
        },
      };
    });
    return fixture.loadRoute(routePath);
  }

  it('exposes isV2Pipeline from the public index', async () => {
    const rag = (await import('@/lib/rag')) as unknown as { isV2Pipeline?: () => boolean };
    expect(typeof rag.isV2Pipeline).toBe('function');
    env.RAG_PIPELINE = 'v2';
    expect(rag.isV2Pipeline?.()).toBe(true);
    env.RAG_PIPELINE = 'legacy';
    expect(rag.isV2Pipeline?.()).toBe(false);
    delete env.RAG_PIPELINE;
    expect(rag.isV2Pipeline?.()).toBe(false);
  });

  describe('chat', () => {
    it('passes a valid retrievalFilters to runRetrieval under v2', async () => {
      const { POST } = await loadRoute('chat', 'v2');
      const response = await POST(chatBody({ retrievalFilters: { languages: ['it'] } }));
      await response.text();

      expect(response.status).toBe(200);
      const calls = retrievalCalls('chat');
      expect(calls).toHaveLength(1);
      expect(calls[0].retrievalFilters).toEqual({ languages: ['it'] });
    });

    it('returns 400 JSON before any stream for an invalid retrievalFilters under v2', async () => {
      const { POST } = await loadRoute('chat', 'v2');
      const response = await POST(chatBody({ retrievalFilters: { documentIds: [] } }));

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as { success: boolean; error: string; details: Array<{ path: string; message: string }> };
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe('string');
      expect(body.details[0].path).toBe('documentIds');
      expect(h.runSpy).not.toHaveBeenCalled();
      expect(h.capture.calls).toHaveLength(0);
    });

    it('rejects an unknown filter key under v2', async () => {
      const { POST } = await loadRoute('chat', 'v2');
      const response = await POST(chatBody({ retrievalFilters: { tenantId: DOC_ID } }));

      expect(response.status).toBe(400);
      expect(h.runSpy).not.toHaveBeenCalled();
    });

    it('sends no retrievalFilters key when the body has none, under either pipeline', async () => {
      for (const pipeline of ['v2', 'legacy', undefined]) {
        h.runSpy.mockReset();
        const { POST } = await loadRoute('chat', pipeline);
        const response = await POST(chatBody());
        await response.text();

        expect(response.status).toBe(200);
        const calls = retrievalCalls('chat');
        expect(calls).toHaveLength(1);
        expect('retrievalFilters' in calls[0]).toBe(false);
      }
    });

    it('RAG_PIPELINE=legacy ignores retrievalFilters (chat)', async () => {
      for (const pipeline of ['legacy', undefined]) {
        h.capture.reset();
        h.runSpy.mockReset();
        const first = await loadRoute('chat', pipeline);
        const plain = await first.POST(chatBody());
        await plain.text();
        const plainSystem = h.capture.calls.map(systemTextOf);

        h.capture.reset();
        h.runSpy.mockReset();
        const second = await loadRoute('chat', pipeline);
        const withField = await second.POST(chatBody({ retrievalFilters: { documentIds: [] } }));
        await withField.text();

        expect(withField.status).toBe(plain.status);
        expect(withField.status).toBe(200);
        expect(h.capture.calls.map(systemTextOf)).toEqual(plainSystem);
        const calls = retrievalCalls('chat');
        expect(calls).toHaveLength(1);
        expect('retrievalFilters' in calls[0]).toBe(false);
      }
    });
  });

  describe('embed', () => {
    it('passes a valid retrievalFilters to runRetrieval under v2', async () => {
      const { POST } = await loadRoute('embed/chat', 'v2');
      const response = await POST(embedBody({ retrievalFilters: { languages: ['it'] } }));
      await response.text();

      expect(response.status).toBe(200);
      const calls = retrievalCalls('embed');
      expect(calls).toHaveLength(1);
      expect(calls[0].retrievalFilters).toEqual({ languages: ['it'] });
    });

    it('returns 400 JSON before any stream for an invalid retrievalFilters under v2', async () => {
      const { POST } = await loadRoute('embed/chat', 'v2');
      const response = await POST(embedBody({ retrievalFilters: { documentIds: [] } }));

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      const body = (await response.json()) as { success: boolean; error: string; details: Array<{ path: string; message: string }> };
      expect(body.success).toBe(false);
      expect(body.details[0].path).toBe('documentIds');
      expect(h.runSpy).not.toHaveBeenCalled();
      expect(h.capture.calls).toHaveLength(0);
    });

    it('sends no retrievalFilters key when the body has none, under either pipeline', async () => {
      for (const pipeline of ['v2', 'legacy', undefined]) {
        h.runSpy.mockReset();
        const { POST } = await loadRoute('embed/chat', pipeline);
        const response = await POST(embedBody());
        await response.text();

        expect(response.status).toBe(200);
        const calls = retrievalCalls('embed');
        expect(calls).toHaveLength(1);
        expect('retrievalFilters' in calls[0]).toBe(false);
      }
    });

    it('RAG_PIPELINE=legacy ignores retrievalFilters (embed)', async () => {
      for (const pipeline of ['legacy', undefined]) {
        h.capture.reset();
        h.runSpy.mockReset();
        const first = await loadRoute('embed/chat', pipeline);
        const plain = await first.POST(embedBody());
        await plain.text();
        const plainSystem = h.capture.calls.map(systemTextOf);

        h.capture.reset();
        h.runSpy.mockReset();
        const second = await loadRoute('embed/chat', pipeline);
        const withField = await second.POST(embedBody({ retrievalFilters: { documentIds: [] } }));
        await withField.text();

        expect(withField.status).toBe(plain.status);
        expect(withField.status).toBe(200);
        expect(h.capture.calls.map(systemTextOf)).toEqual(plainSystem);
        const calls = retrievalCalls('embed');
        expect(calls).toHaveLength(1);
        expect('retrievalFilters' in calls[0]).toBe(false);
      }
    });
  });
});
