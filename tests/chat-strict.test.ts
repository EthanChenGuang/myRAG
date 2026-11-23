import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, emptyRetrieval, readSse } from './helpers/chat-route-fakes';

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

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

async function loadRoute() {
  vi.resetModules();
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

describe('chat route strict mode with no knowledge-base context', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('answers Information Not Available and never calls streamText', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the refund policy for annual plans?' }],
        data: { ragMode: 'strict', settings: { webSearch: false } },
      }),
    );
    const body = await readSse(response);

    expect(h.retrieval).toHaveBeenCalled();
    expect(h.retrieval.mock.calls[0][0]).toBe('match_document_chunks');
    expect(body).toContain('Information Not Available');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('answers in Spanish when the request language is es', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the refund policy for annual plans?' }],
        data: { ragMode: 'strict', settings: { webSearch: false, language: 'es' } },
      }),
    );
    const body = await readSse(response);

    expect(body).toContain('Información no disponible');
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });
});
