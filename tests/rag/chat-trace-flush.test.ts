import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../helpers/chat-route-fakes';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    traced: [] as Array<{ stages: Array<{ name: string; status: string }> }>,
    provider: { missing: false },
  };
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/rag/trace/finish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
  return {
    ...actual,
    finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
      h.traced.push({ stages: args[0].stages().map((stage) => ({ name: stage.name, status: stage.status })) });
      return actual.finishTrace(...args);
    },
  };
});
vi.mock('@/lib/document-processor', () => ({ getQueryEmbedding: vi.fn(async () => []) }));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
  searchSimilarChunks: vi.fn(async () => []),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => (h.provider.missing ? null : { specificationVersion: 'v3', provider: 'fake', modelId }),
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

const savedKey = process.env.OPENROUTER_API_KEY;

async function post() {
  vi.resetModules();
  await installChatPipeline(h);
  const { POST } = await import('@/app/api/chat/route');
  return POST(
    chatRequest({
      messages: [{ role: 'user', content: 'What is the refund policy for annual plans?' }],
      data: { ragMode: 'flexible', settings: { webSearch: false } },
    }),
  );
}

function generationStatuses(): string[] {
  return h.traced.flatMap((trace) => trace.stages.filter((stage) => stage.name === 'generation').map((stage) => stage.status));
}

describe('chat route trace flush and generation status', () => {
  beforeEach(() => {
    h.traced.length = 0;
    h.provider.missing = false;
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([]));
    h.supabase.store.reset();
    h.supabase.store.documents = [];
    h.supabase.store.document_chunks = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  });

  it('flushes the trace once when the API key check fails', async () => {
    process.env.OPENROUTER_API_KEY = 'not-a-valid-key';
    await readSse(await post());

    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(h.traced).toHaveLength(1);
  });

  it('flushes the trace once when the model provider cannot be created', async () => {
    h.provider.missing = true;
    await readSse(await post());

    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(h.traced).toHaveLength(1);
  });

  it('records generation ok for a completed stream', async () => {
    await readSse(await post());

    expect(h.traced).toHaveLength(1);
    expect(generationStatuses()).toEqual(['ok']);
  });

  it('records generation error when the model stream fails', async () => {
    h.capture.setStreamError(new Error('upstream model failed'));
    await readSse(await post());

    expect(h.traced).toHaveLength(1);
    expect(generationStatuses()).toEqual(['error']);
  });

  it('records generation aborted when the model stream is aborted', async () => {
    h.capture.setAbort(true);
    await readSse(await post());

    expect(h.traced).toHaveLength(1);
    expect(generationStatuses()).toEqual(['aborted']);
  });
});
