import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRequest, installChatPipeline, readSse, retrievalWith } from '../helpers/chat-route-fakes';

const QUESTION = 'What does the first placeholder section describe?';
const LANGUAGE_VARS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), traced: [] as Array<{ status: string; reason?: string }> };
});

vi.mock('@/lib/rag/trace/finish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/trace/finish')>();
  return {
    ...actual,
    finishTrace: (...args: Parameters<typeof actual.finishTrace>) => {
      h.traced.push({ status: args[1].status, reason: args[1].reason });
      return actual.finishTrace(...args);
    },
  };
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

const saved: Record<string, string | undefined> = {};

async function loadRoute(ragEnv: Record<string, string>) {
  vi.resetModules();
  await installChatPipeline(h);
  const settings = await import('@/lib/rag/lang/settings');
  settings.resetLanguageSettingsForTests();
  const deps = await import('@/lib/rag/deps');
  deps.setRagDepsForTests({ ragEnv: () => ragEnv });
  return import('@/app/api/chat/route');
}

function post(route: Awaited<ReturnType<typeof loadRoute>>, data: Record<string, unknown> = {}) {
  return route.POST(
    chatRequest({
      messages: [{ role: 'user', content: QUESTION }],
      data: { ragMode: 'strict', settings: { webSearch: false }, ...data },
    }),
  );
}

describe('explicit RAG_PIPELINE=v2 without chosen languages (D-02)', () => {
  beforeEach(() => {
    for (const name of LANGUAGE_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    h.traced.length = 0;
    h.capture.reset();
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([]));
    h.supabase.store.reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of LANGUAGE_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.restoreAllMocks();
  });

  it('strict chat streams the knowledge-base-unavailable message, never "information not available", and traces languages_not_configured', async () => {
    const response = await post(await loadRoute({ RAG_PIPELINE: 'v2' }));
    const body = await readSse(response);

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"error"');
    expect(body).toContain('temporarily unavailable');
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).not.toHaveBeenCalled();
    expect(h.retrieval).not.toHaveBeenCalled();
    expect(h.traced).toEqual([{ status: 'error', reason: 'languages_not_configured' }]);
  });

  it('keeps serving: a second request gets the same answer and no exception escapes', async () => {
    const route = await loadRoute({ RAG_PIPELINE: 'v2' });
    for (let i = 0; i < 2; i += 1) {
      const body = await readSse(await post(route, { settings: { webSearch: false, language: 'zh' } }));
      expect(body).toContain('知识库暂时无法访问');
    }
    expect(h.traced.map((entry) => entry.reason)).toEqual(['languages_not_configured', 'languages_not_configured']);
  });

  it('with web search on the answer continues without knowledge-base context', async () => {
    const body = await readSse(await post(await loadRoute({ RAG_PIPELINE: 'v2' }), { settings: { webSearch: true } }));
    expect(body).not.toContain('"type":"error"');
    expect(body).not.toContain('Information Not Available');
    expect(h.capture.streamText).toHaveBeenCalledTimes(1);
  });

  it('RAG_PIPELINE=legacy with the languages unset answers as today (the strict refusal for an empty retrieval)', async () => {
    const body = await readSse(await post(await loadRoute({ RAG_PIPELINE: 'legacy' })));
    expect(body).toContain('Information Not Available');
    expect(body).not.toContain('temporarily unavailable');
    expect(h.retrieval).toHaveBeenCalled();
    expect(h.traced.map((entry) => entry.reason)).not.toContain('languages_not_configured');
  });

  it('explicit v2 with the languages chosen runs retrieval', async () => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
    process.env.RAG_PRIMARY_LANGUAGE = 'en';
    const body = await readSse(await post(await loadRoute({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' })));
    expect(body).not.toContain('temporarily unavailable');
    expect(h.traced.map((entry) => entry.reason)).not.toContain('languages_not_configured');
  });
});

describe('explicit RAG_INGEST_PIPELINE=unified without chosen languages (D-02)', () => {
  beforeEach(() => {
    for (const name of [...LANGUAGE_VARS, 'RAG_INGEST_PIPELINE']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const name of [...LANGUAGE_VARS, 'RAG_INGEST_PIPELINE']) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    const deps = await import('@/lib/rag/ingest/deps');
    deps.resetIngestDepsForTests();
    vi.restoreAllMocks();
  });

  async function withIngestEnv(ingestEnv: Record<string, string>) {
    vi.resetModules();
    const settings = await import('@/lib/rag/lang/settings');
    settings.resetLanguageSettingsForTests();
    const deps = await import('@/lib/rag/ingest/deps');
    const db = vi.fn(() => null);
    deps.setIngestDepsForTests({ ingestEnv: () => ingestEnv, db });
    return { rag: await import('@/lib/rag'), db };
  }

  const input = () =>
    ({
      scope: { kind: 'single' },
      source: 'upload',
      sourceKey: 'placeholder-key',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      text: 'Placeholder paragraph.',
      signal: new AbortController().signal,
    }) as never;

  it('every unified write entry refuses with languages_not_configured and touches no database', async () => {
    const { rag, db } = await withIngestEnv({ RAG_INGEST_PIPELINE: 'unified' });
    expect(rag.unifiedIngestRefusal()).toEqual({ error: 'languages_not_configured' });
    expect(await rag.ingest(input())).toMatchObject({ status: 'failed', reason: 'languages_not_configured', documentId: null });
    expect(await rag.submitIngest(input())).toMatchObject({ status: 'failed', reason: 'languages_not_configured' });
    expect(db).not.toHaveBeenCalled();
  });

  it('the legacy ingest pipeline is not refused', async () => {
    const { rag } = await withIngestEnv({ RAG_INGEST_PIPELINE: 'legacy' });
    expect(rag.unifiedIngestRefusal()).toBeNull();
    expect(rag.currentIngestConfig().pipelineBlocked).toBeNull();
  });

  it('unified with the languages chosen is not refused', async () => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
    process.env.RAG_PRIMARY_LANGUAGE = 'en';
    const { rag } = await withIngestEnv({ RAG_INGEST_PIPELINE: 'unified' });
    expect(rag.unifiedIngestRefusal()).toBeNull();
    expect(rag.currentIngestConfig().pipeline).toBe('unified');
  });
});
