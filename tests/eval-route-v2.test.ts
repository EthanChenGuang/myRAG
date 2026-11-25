import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline } from './helpers/chat-route-fakes';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE'] as const;
const env = process.env as Record<string, string | undefined>;
const DOC_ID = '11111111-1111-4111-8111-111111111111';

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

function legacyResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [
      {
        chunk_id: 'chunk-1',
        document_id: 'doc-1',
        content: 'Refund policy chunk',
        similarity: 0.8,
        metadata: null,
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.8,
        match_reason: 'similarity',
      },
    ],
    context: 'Refund policy chunk',
    usedDocuments: [{ id: 'doc-1', name: 'refund.md', filename: 'refund.md', similarity: 0.8 }],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: [
      { name: 'search', status: 'ok', startedAt: 0, endedAt: 1, latency_ms: 1, candidates_in: 0, candidates_out: 1, rules: [], detail: 'fake' },
      { name: 'assemble', status: 'ok', startedAt: 1, endedAt: 2, latency_ms: 1, candidates_in: 1, candidates_out: 1, rules: [] },
    ],
    traceId: 'trace-stub',
    queryContext: QUERY_CONTEXT,
    ...overrides,
  };
}

function v2Result(overrides: Record<string, unknown> = {}) {
  const base = legacyResult();
  return {
    ...base,
    context: 'Clause 4 allows refunds within thirty days.',
    candidates: [
      {
        ...base.candidates[0],
        rerank_score: 0.71,
        fused_score: 0.03,
        legs: { dense: 1, lexical: 3 },
        language: 'en',
      },
      { ...base.candidates[0], chunk_id: 'chunk-2', document_id: 'doc-2', language: null },
    ],
    stages: [
      { ...base.stages[0], counts: { dense_hits: 12, lexical_hits: 7 } },
      { name: 'rerank', status: 'ok', startedAt: 1, endedAt: 2, latency_ms: 1, candidates_in: 12, candidates_out: 8, rules: [], counts: { scored: 12 } },
      base.stages[1],
    ],
    retrievalConfigHash: 'f'.repeat(64),
    queryLanguage: 'en',
    refusal: { decision: 'answer', basis: 'rerank_threshold', reason: 'above_threshold', topScore: 0.71, threshold: 0.6, cellKey: 'cohere|fake-quality-v1|en|same' },
    ...overrides,
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
    body: JSON.stringify({
      schema_version: 1,
      query: 'What is the refund window?',
      rag_mode: 'strict',
      ...(options ? { options } : {}),
    }),
  });
}

describe('eval route v2 overrides, filters and trace fields', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.runSpy.mockReset();
    h.next.result = legacyResult();
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

  it('maps options.retrieval_overrides to stageOverrides.retrievalOverrides', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ retrieval_overrides: { final_top_k: 5 } }));

    expect(response.status).toBe(200);
    expect(h.runSpy).toHaveBeenCalledTimes(1);
    const input = h.runSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    expect(input.stageOverrides?.retrievalOverrides).toEqual({ finalTopK: 5 });
  });

  it('maps every override field and keeps the disabled stages beside it', async () => {
    const route = await loadRoute();
    const response = await route.POST(
      evalRequest({
        disabled_stages: ['local_rerank'],
        retrieval_overrides: {
          candidate_pool_size: 60,
          rerank_input_cap: 50,
          final_top_k: 8,
          rrf_k: 40,
          leg_weights: { dense: 1, lexical: 0.5, exact_id: 2 },
          rerank_model: 'fake-quality-v1',
        },
      }),
    );

    expect(response.status).toBe(200);
    const stageOverrides = h.runSpy.mock.calls[0][0].stageOverrides;
    expect(stageOverrides?.disabledStages).toEqual(['local_rerank']);
    expect(stageOverrides?.retrievalOverrides).toEqual({
      candidatePoolSize: 60,
      rerankInputCap: 50,
      finalTopK: 8,
      rrfK: 40,
      legWeights: { dense: 1, lexical: 0.5, exactId: 2 },
      rerankModel: 'fake-quality-v1',
    });
  });

  it('maps chunking_profile_by_doc_type to chunkingProfileByDocType and drops an empty map', async () => {
    const route = await loadRoute();
    const response = await route.POST(
      evalRequest({ retrieval_overrides: { chunking_profile_by_doc_type: { contract_legal: 'p256-1024-contract_legal' } } }),
    );
    expect(response.status).toBe(200);
    expect(h.runSpy.mock.calls[0][0].stageOverrides?.retrievalOverrides).toEqual({
      chunkingProfileByDocType: { contract_legal: 'p256-1024-contract_legal' },
    });

    const empty = await route.POST(evalRequest({ retrieval_overrides: { chunking_profile_by_doc_type: {} } }));
    expect(empty.status).toBe(200);
    expect(h.runSpy.mock.calls[1][0].stageOverrides).toBeUndefined();
  });

  it('sends no stageOverrides when the request carries no overrides', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ max_results: 5 }));

    expect(response.status).toBe(200);
    expect(h.runSpy.mock.calls[0][0].stageOverrides).toBeUndefined();
    expect(h.runSpy.mock.calls[0][0].retrievalFilters).toBeUndefined();
  });

  it('maps options.retrieval_filters to retrievalFilters', async () => {
    const route = await loadRoute();
    const response = await route.POST(
      evalRequest({
        retrieval_filters: {
          doc_types: ['contract_legal'],
          document_ids: [DOC_ID],
          date_range: { from: '2025-01-01', to: '2025-12-31' },
          languages: ['it'],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(h.runSpy.mock.calls[0][0].retrievalFilters).toEqual({
      dateRange: { from: '2025-01-01', to: '2025-12-31' },
      documentIds: [DOC_ID],
      docTypes: ['contract_legal'],
      languages: ['it'],
    });
  });

  it('rejects an empty filter list with 400 before retrieval', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ retrieval_filters: { doc_types: [] } }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: string; details: Array<{ path: string; message: string }> };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.details[0].path).toBe('docTypes');
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it('rejects an inverted date range with 400 before retrieval', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ retrieval_filters: { date_range: { from: '2025-12-31', to: '2025-01-01' } } }));

    expect(response.status).toBe(400);
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it('writes the v2 trace fields for a v2 result', async () => {
    h.next.result = v2Result();
    const route = await loadRoute();
    const response = await route.POST(evalRequest());

    expect(response.status).toBe(200);
    const trace = (await response.json()) as Record<string, any>;
    expect(trace.refused).toBe(false);
    expect(trace.refusal_reason).toBeNull();
    expect(trace.refusal).toEqual({
      decision: 'answer',
      basis: 'rerank_threshold',
      reason: 'above_threshold',
      top_score: 0.71,
      threshold: 0.6,
      cell_key: 'cohere|fake-quality-v1|en|same',
    });
    expect(trace.retrieval_config_hash).toBe('f'.repeat(64));
    expect(trace.context_tokens).toBe(countTokens('Clause 4 allows refunds within thirty days.'));
    expect(trace.query_language).toBe('en');
    expect(trace.retrieval_versions).toEqual({ lexical: LEXICAL_VERSION, rerank_text: RERANK_TEXT_VERSION });
    expect(trace.stage_counts).toEqual({ search: { dense_hits: 12, lexical_hits: 7 }, rerank: { scored: 12 } });
    expect(trace.candidates[0]).toMatchObject({ rerank_score: 0.71, fused_score: 0.03, legs: { dense: 1, lexical: 3 }, language: 'en' });
    expect(trace.candidates[1].rerank_score).toBeNull();
    expect(trace.candidates[1].fused_score).toBeNull();
    expect(trace.candidates[1].language).toBeNull();
    expect('legs' in trace.candidates[1]).toBe(false);
  });

  it('reports a similarity floor refusal as below_similarity_floor', async () => {
    h.next.result = v2Result({
      status: 'empty',
      reason: 'below_similarity_floor',
      context: '',
      refusalCandidate: true,
      refusal: { decision: 'refuse', basis: 'similarity_floor', reason: 'below_similarity_floor', topScore: 0.21, threshold: 0.3, cellKey: null },
    });
    const route = await loadRoute();
    const response = await route.POST(evalRequest());

    expect(response.status).toBe(200);
    const trace = (await response.json()) as Record<string, any>;
    expect(trace.refused).toBe(true);
    expect(trace.refusal_reason).toBe('below_similarity_floor');
    expect(trace.refusal).toMatchObject({ decision: 'refuse', basis: 'similarity_floor', top_score: 0.21, threshold: 0.3, cell_key: null });
    expect(trace.context_tokens).toBe(0);
  });

  it('reports a rerank threshold refusal as below_threshold', async () => {
    h.next.result = v2Result({
      status: 'empty',
      reason: 'below_threshold',
      context: '',
      refusalCandidate: true,
      refusal: { decision: 'refuse', basis: 'rerank_threshold', reason: 'below_threshold', topScore: 0.4, threshold: 0.6, cellKey: 'cohere|fake-quality-v1|en|same' },
    });
    const route = await loadRoute();
    const response = await route.POST(evalRequest());

    const trace = (await response.json()) as Record<string, any>;
    expect(trace.refused).toBe(true);
    expect(trace.refusal_reason).toBe('below_threshold');
  });

  it('marks a gate refusal as refused even when assembly did not flag it', async () => {
    h.next.result = v2Result({
      refusalCandidate: false,
      refusal: { decision: 'refuse', basis: 'rerank_threshold', reason: 'below_threshold', topScore: 0.4, threshold: 0.6, cellKey: null },
    });
    const route = await loadRoute();
    const trace = (await (await route.POST(evalRequest())).json()) as Record<string, any>;

    expect(trace.refused).toBe(true);
    expect(trace.refusal_reason).toBe('below_threshold');
  });

  it('leaves a legacy trace without any v2 field', async () => {
    h.next.result = legacyResult({ refusalCandidate: true });
    const route = await loadRoute();
    const response = await route.POST(evalRequest());

    expect(response.status).toBe(200);
    const trace = (await response.json()) as Record<string, any>;
    expect(trace.refused).toBe(true);
    expect(trace.refusal_reason).toBe('no_relevant_context');
    expect(trace.refusal).toBeNull();
    expect(trace.retrieval_config_hash).toBeNull();
    expect(trace.context_tokens).toBeNull();
    expect(trace.query_language).toBeNull();
    expect(trace.retrieval_versions).toBeNull();
    expect('stage_counts' in trace).toBe(false);
    expect(trace.candidates[0].rerank_score).toBeNull();
    expect(trace.candidates[0].fused_score).toBeNull();
    expect(trace.candidates[0].language).toBeNull();
    expect('legs' in trace.candidates[0]).toBe(false);
  });
});
