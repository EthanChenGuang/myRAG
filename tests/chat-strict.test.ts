import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { hit } from './rag/fusion/helpers';
import { verifyV2Startup, resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient } from './rag/helpers/pipeline-fakes';
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

async function loadRoute(options: { ragEnv?: () => Record<string, string> } = {}) {
  vi.resetModules();
  await installChatPipeline(h);
  if (options.ragEnv) {
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({ ragEnv: options.ragEnv });
  }
  return import('@/app/api/chat/route');
}

function v2Backend(similarity: number): RetrievalBackend {
  return {
    id: 'pgvector',
    search: async () => ({
      dense: [hit('chunk-1', { similarity, documentId: 'doc-1', content: 'refund policy text' })],
      lexical: [],
    } satisfies BackendLegs),
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
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

  it.each([
    { language: 'en', snippet: 'Information Not Available' },
    { language: 'zh', snippet: 'Information Not Available' },
    { language: 'it', snippet: 'Information Not Available' },
  ])('under RAG_PIPELINE=v2 with similarity 0.40 streams the localized refusal for $language', async ({ language, snippet }) => {
    resetV2StartupForTests();
    resetRetrievalBackendForTests();
    resetActiveChunkingProfilesForTests();
    setRetrievalBackendForTests(v2Backend(0.4));
    const { embedder } = fakeEmbedder();
    const rpc = fakeRpcClient();
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({
      embedder,
      adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }),
    });
    await verifyV2Startup();
    const { POST } = await loadRoute({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }) });
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the refund policy for annual plans?' }],
        data: { ragMode: 'strict', settings: { webSearch: false, language } },
      }),
    );
    const body = await readSse(response);
    expect(body).toContain(snippet);
    expect(h.capture.streamText).not.toHaveBeenCalled();
  });

  it('under RAG_PIPELINE=v2 with web search on does not stream the information-not-available response', async () => {
    resetV2StartupForTests();
    resetRetrievalBackendForTests();
    resetActiveChunkingProfilesForTests();
    setRetrievalBackendForTests(v2Backend(0.4));
    const rpc = fakeRpcClient();
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({
      embedder: fakeEmbedder().embedder,
      adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }),
    });
    await verifyV2Startup();
    const { POST } = await loadRoute({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }) });
    const response = await POST(
      chatRequest({
        messages: [{ role: 'user', content: 'What is the refund policy for annual plans?' }],
        data: { ragMode: 'strict', settings: { webSearch: true } },
      }),
    );
    const body = await readSse(response);
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalled();
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
