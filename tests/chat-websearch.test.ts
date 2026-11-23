import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, emptyRetrieval, readSse } from './helpers/chat-route-fakes';

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: h.capture.streamText,
}));
vi.mock('@/lib/enhanced-rag-retrieval', () => ({ enhancedRetrieveChunks: h.retrieval }));
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
vi.mock('@/lib/thinking-rag-enhancer', () => ({
  createEnhancedRAGPrompt: (base: string, context: string) => base.replace('{{context}}', context),
  enhanceQueryWithReasoning: vi.fn(),
  intelligentSearch: vi.fn(),
  shouldUseEnhancedRAG: () => true,
}));

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/chat/route');
}

describe('chat route strict mode with webSearch enabled', () => {
  beforeEach(() => {
    h.capture.reset();
    h.exa.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(emptyRetrieval());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not refuse and hands the model an Exa-backed webSearch tool', async () => {
    h.exa.searchAndContents.mockResolvedValue({
      results: [
        {
          title: 'Fake headline',
          url: 'https://example.com/news/1',
          text: 'x'.repeat(1500),
          publishedDate: '2026-01-02',
        },
      ],
    });

    const { POST } = await loadRoute();
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the latest news about the product?' }],
        data: { ragMode: 'strict', settings: { webSearch: true } },
      }),
    );
    const body = await readSse(response);

    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);

    const params = h.capture.calls[0];
    expect(Object.keys(params.tools)).toContain('webSearch');

    const output = await params.tools.webSearch.execute({ query: 'latest news' }, { toolCallId: 'call-1', messages: [] });
    expect(h.exa.searchAndContents).toHaveBeenCalledTimes(1);
    expect(h.exa.searchAndContents).toHaveBeenCalledWith('latest news', { livecrawl: 'always', numResults: 3 });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      title: 'Fake headline',
      url: 'https://example.com/news/1',
      publishedDate: '2026-01-02',
    });
    expect(output[0].content).toHaveLength(1000);
  });

  it('uses no :online model suffix when webSearch is on', async () => {
    const { POST } = await loadRoute();
    await readSse(
      await POST(
        chatRequest({
          messages: [{ role: 'user', content: 'What is the latest news about the product?' }],
          data: { ragMode: 'strict', settings: { webSearch: true, model: 'openai/gpt-4o-mini' } },
        }),
      ),
    );

    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    const params = h.capture.calls[0];
    expect(params.model.modelId).toBe('openai/gpt-4o-mini');
    expect(params.model.modelId).not.toMatch(/:online$/);
  });
});
