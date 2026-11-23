import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from './helpers/chat-route-fakes';

const IMAGE_URL = 'https://example.com/fixtures/diagram.png';

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

function seedImageDocument() {
  h.supabase.store.documents = [
    {
      id: 'doc-image-1',
      filename: 'diagram.png',
      created_at: '2026-01-01T00:00:00.000Z',
      content: 'A fixture diagram',
      metadata: {},
    },
  ];
  h.supabase.store.document_chunks = [
    { id: 'chunk-image-1', document_id: 'doc-image-1', metadata: { image_url: IMAGE_URL } },
  ];
  h.retrieval.mockResolvedValue(
    retrievalWith([
      {
        chunk_id: 'chunk-image-1',
        document_id: 'doc-image-1',
        content: 'Diagram of the architecture',
        similarity: 0.3,
        metadata: { image_url: IMAGE_URL },
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.3,
        match_reason: 'similarity',
      },
    ]),
  );
}

async function postImageQuery() {
  const { POST } = await loadRoute();
  return POST(
    chatRequest({
      messages: [{ role: 'user', content: 'zzzz' }],
      data: { ragMode: 'strict', settings: { webSearch: false } },
    }),
  );
}

describe('chat route source_images', () => {
  beforeEach(() => {
    h.capture.reset();
    h.retrieval.mockReset();
    h.supabase.store.documents = [];
    h.supabase.store.document_chunks = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    seedImageDocument();
  });

  it('streams source_images with the image URL before the first text delta', async () => {
    const body = await readSse(await postImageQuery());

    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
    expect(body).toContain('source_images');
    expect(body).toContain(IMAGE_URL);
    expect(body).toContain('"delta":"ok"');
    expect(body.indexOf('source_images')).toBeLessThan(body.indexOf('"delta":"ok"'));
  });

  it('persists a source_images part in onStepFinish tool results', async () => {
    await readSse(await postImageQuery());

    const params = h.capture.calls[0];
    expect(typeof params.onStepFinish).toBe('function');

    const toolResults: Array<Record<string, any>> = [];
    await params.onStepFinish({ text: '', toolCalls: [], toolResults });

    const persisted = toolResults.filter((part) => part.type === 'source_images');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].source_images).toEqual([
      { name: 'diagram.png', size: 0, type: 'image/jpeg', url: IMAGE_URL },
    ]);
    const documentSources = toolResults.find((part) => part.toolName === 'query_documents');
    expect(documentSources?.output.images).toEqual([
      { name: 'diagram.png', size: 0, type: 'image/jpeg', url: IMAGE_URL },
    ]);
  });

  it('keeps the image document out of the model context text', async () => {
    await readSse(await postImageQuery());

    const serialized = JSON.stringify(h.capture.calls[0].messages);
    expect(serialized).toContain('RELEVANT INFORMATION FROM DOCUMENTS');
    expect(serialized).not.toContain('Diagram of the architecture');
  });
});
