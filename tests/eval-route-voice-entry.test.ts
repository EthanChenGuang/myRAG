import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline } from './helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE'] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn(), next: { result: null as unknown } };
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

const QUERY_CONTEXT = {
  isTemporalQuery: false,
  isFinancialQuery: false,
  isSpecificDataQuery: false,
  requiredPrecision: 'low' as const,
  suggestedThreshold: 0.3,
  reasoningText: 'stub',
  financialMetrics: [],
  searchStrategy: 'semantic_only' as const,
};

const STAGES = [
  { name: 'embed', status: 'ok', startedAt: 0, endedAt: 4, latency_ms: 4, candidates_in: 0, candidates_out: 0, rules: [] },
  { name: 'search', status: 'ok', startedAt: 4, endedAt: 9, latency_ms: 5, candidates_in: 0, candidates_out: 2, rules: [], detail: 'fake' },
];

function voiceResultRow(id: string, similarity: number, extra: Record<string, unknown> = {}) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Synthetic module ${id} notes`,
    similarity,
    metadata: { document_title: `module-${id}.md` },
    image_url: null,
    ...extra,
  };
}

function voiceRetrieval(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: STAGES,
    traceId: 'trace-voice',
    queryContext: null,
    voice: {
      results: [voiceResultRow('b', 0.91, { rerankScore: 0.91 }), voiceResultRow('a', 0.62)],
      source_images: [],
    },
    ...overrides,
  };
}

function evalRetrieval() {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [],
    context: 'Synthetic context',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: [...STAGES, { name: 'assemble', status: 'ok', startedAt: 9, endedAt: 10, latency_ms: 1, candidates_in: 2, candidates_out: 0, rules: [] }],
    traceId: 'trace-eval',
    queryContext: QUERY_CONTEXT,
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.runSpy(input);
        const trace = input.trace;
        if (trace) {
          for (const stage of STAGES) trace.record({ name: stage.name as 'embed' | 'search', status: 'ok', startedAt: stage.startedAt, endedAt: stage.endedAt });
        }
        return Promise.resolve(h.next.result);
      },
    };
  });
  await installChatPipeline(h);
  return import('@/app/api/internal/rag/run/route');
}

function evalRequest(options?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/internal/rag/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
    body: JSON.stringify({ schema_version: 1, query: 'Which module routes synthetic requests?', rag_mode: 'strict', ...(options ? { options } : {}) }),
  });
}

describe('eval route entry_profile voice (Phase 6.2 D-16, P-26)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.runSpy.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  it('runs retrieval with the voice profile under the eval scope and maps the voice results to kept in rank order', async () => {
    h.next.result = voiceRetrieval();
    const { POST } = await loadRoute();
    const response = await POST(evalRequest({ entry_profile: 'voice', max_results: 4 }));
    expect(response.status).toBe(200);
    const input = h.runSpy.mock.calls[0]![0];
    expect(input.profile).toBe('voice');
    expect(input.scope).toMatchObject({ kind: 'single', userId: null });
    expect(input.options).toMatchObject({ maxResults: 4 });
    expect(input.evalEntry).toBe(true);
    const trace = await response.json();
    expect(trace.kept.map((chunk: { chunk_id: string }) => chunk.chunk_id)).toEqual(['chunk-b', 'chunk-a']);
    expect(trace.kept.map((chunk: { rank: number }) => chunk.rank)).toEqual([1, 2]);
    expect(trace.kept.map((chunk: { document_name: string }) => chunk.document_name)).toEqual(['module-b.md', 'module-a.md']);
    expect(trace.kept.map((chunk: { kept_by: string }) => chunk.kept_by)).toEqual(['rerank', 'similarity']);
    expect(trace.used_documents.map((doc: { document_id: string }) => doc.document_id)).toEqual(['doc-b', 'doc-a']);
    expect(trace.stage_latency_ms).toMatchObject({ embed: expect.any(Number), search: expect.any(Number) });
    expect(trace.refused).toBe(false);
    expect(trace.answer).toBeNull();
  });

  it('applies no eval-only override, filter or cache context under the voice entry', async () => {
    h.next.result = voiceRetrieval();
    const { POST } = await loadRoute();
    const response = await POST(
      evalRequest({
        entry_profile: 'voice',
        retrieval_overrides: { final_top_k: 3 },
        disabled_stages: ['refs'],
        query_layer: true,
        query_transforms: { translate: true },
        semantic_cache: 'pgvector',
        retrieval_filters: { doc_types: ['general'] },
      }),
    );
    expect(response.status).toBe(200);
    const input = h.runSpy.mock.calls[0]![0];
    expect(input.profile).toBe('voice');
    expect(input.stageOverrides).toBeUndefined();
    expect(input.retrievalFilters).toBeUndefined();
    expect(input.cacheContext).toBeUndefined();
    expect(input.citationLabeler).toBeUndefined();
  });

  it('traces an empty voice result as a refusal with an empty kept list', async () => {
    h.next.result = voiceRetrieval({ status: 'empty', reason: 'no_candidates', voice: { results: [], source_images: [] } });
    const { POST } = await loadRoute();
    const response = await POST(evalRequest({ entry_profile: 'voice' }));
    expect(response.status).toBe(200);
    const trace = await response.json();
    expect(trace.kept).toEqual([]);
    expect(trace.refused).toBe(true);
  });

  it('answers 500 when voice retrieval fails', async () => {
    h.next.result = voiceRetrieval({ status: 'error', reason: 'backend_error', voice: { results: [], source_images: [] } });
    const { POST } = await loadRoute();
    const response = await POST(evalRequest({ entry_profile: 'voice' }));
    expect(response.status).toBe(500);
  });

  it('keeps the eval profile when entry_profile is eval or absent', async () => {
    h.next.result = evalRetrieval();
    const { POST } = await loadRoute();
    for (const options of [undefined, { entry_profile: 'eval' }]) {
      h.runSpy.mockReset();
      const response = await POST(evalRequest(options));
      expect(response.status).toBe(200);
      expect(h.runSpy.mock.calls[0]![0].profile).toBe('eval');
      expect(h.runSpy.mock.calls[0]![0].evalEntry).toBeUndefined();
    }
  });

  it('rejects an unknown entry profile with 400 before retrieval', async () => {
    h.next.result = evalRetrieval();
    const { POST } = await loadRoute();
    const response = await POST(evalRequest({ entry_profile: 'chat' }));
    expect(response.status).toBe(400);
    expect(h.runSpy).not.toHaveBeenCalled();
  });
});
