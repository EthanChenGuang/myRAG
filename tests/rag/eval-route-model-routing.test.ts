import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline } from '../helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const FAST = 'anthropic/claude-haiku-5.5';
const QUALITY = 'anthropic/claude-sonnet-5.5';
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_PIPELINE',
  'RAG_QUERY_LAYER',
  'RAG_MODEL_ROUTING',
  'RAG_ROUTING_FAST_MODEL',
  'RAG_ROUTING_QUALITY_MODEL',
  'NEXT_PUBLIC_MCP_SYSTEM_ENABLED',
] as const;
const env = process.env as Record<string, string | undefined>;
const QUERY = 'Tell me about the alpha module';
const LONG_QUERY = 'What is the recorded alpha value of the synthetic sample listed in the third section of the neutral test document?';
const KEPT = [{ chunk_id: 'chunk-1', document_id: 'doc-1', document_name: 'alpha.md', content: 'The alpha module stores neutral sample values.', similarity: 0.8, rank: 1, kept_by: 'similarity' as const }];

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn(), next: { result: null as unknown } };
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

function plan(reasons: string[] = []) {
  return {
    original: QUERY,
    standalone: QUERY,
    framework: 'llamaindex',
    language: 'en',
    gate: { lang: 'en', protected_tokens: [], reasons, rewrite: reasons.length > 0, skip_retrieval: false, transforms: [] },
    variants: [{ kind: 'original', language: 'en', protected_ok: true, sub_question_index: null, text: QUERY }],
    date_range: null,
  };
}

function result(queryPlan: unknown = plan(), overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [
      {
        chunk_id: 'chunk-1',
        document_id: 'doc-1',
        content: 'The alpha module stores neutral sample values.',
        similarity: 0.8,
        metadata: null,
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.8,
        match_reason: 'similarity',
      },
    ],
    context: 'The alpha module stores neutral sample values.',
    usedDocuments: [{ id: 'doc-1', name: 'alpha.md', filename: 'alpha.md', similarity: 0.8 }],
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
    queryContext: {
      isTemporalQuery: false,
      isFinancialQuery: false,
      isSpecificDataQuery: false,
      requiredPrecision: 'low' as const,
      suggestedThreshold: 0.3,
      reasoningText: 'stub',
      financialMetrics: [],
      searchStrategy: 'semantic_only' as const,
    },
    queryPlan,
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

async function run(options: Record<string, unknown>, next: unknown = result(), query: string = QUERY) {
  h.next.result = next;
  const route = await loadRoute();
  const answer = await import('@/lib/rag-eval/answer');
  const { MockLanguageModelV3 } = await import('ai/test');
  const models: string[] = [];
  answer.setEvalLanguageModelFactory((modelId: string) => {
    models.push(modelId);
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'A neutral synthetic answer.' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
  });
  try {
    const response = await route.POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
        body: JSON.stringify({ schema_version: 1, query, rag_mode: 'strict', include_answer: true, options }),
      }),
    );
    expect(response.status).toBe(200);
    return { trace: (await response.json()) as Record<string, any>, models };
  } finally {
    answer.setEvalLanguageModelFactory(null);
  }
}

describe('eval route selected_model and Auto routing (06.2-29, D-19, D-20)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.RAG_PIPELINE = 'v2';
    env.RAG_QUERY_LAYER = 'true';
    env.RAG_MODEL_ROUTING = 'auto';
    delete env.RAG_ROUTING_FAST_MODEL;
    delete env.RAG_ROUTING_QUALITY_MODEL;
    // The classifier says document_search only on its MCP-enabled path (06.2-29 SUMMARY finding).
    env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED = 'true';
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
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('routes a simple lookup to the fast model and records model_route', async () => {
    const { trace, models } = await run({ selected_model: 'auto' });
    expect(trace.model_route).toEqual({ tier: 'fast', rule: 'simple_lookup', selection: 'auto' });
    expect(models).toEqual([FAST]);
    expect(trace.effective_config.generator_model).toBe(QUALITY);
  });

  it('keeps the quality model when a quality rule fires', async () => {
    const { trace, models } = await run({ selected_model: 'auto' }, result(plan(['R6_COMPOUND'])));
    expect(trace.model_route).toEqual({ tier: 'quality', rule: 'gate_compound', selection: 'auto' });
    expect(models).toEqual([QUALITY]);
  });

  it('resolves auto to the quality model with routing off', async () => {
    env.RAG_MODEL_ROUTING = 'off';
    const { trace, models } = await run({ selected_model: 'auto' });
    expect(trace.model_route).toEqual({ tier: 'quality', rule: 'routing_off', selection: 'auto' });
    expect(models).toEqual([QUALITY]);
  });

  it('never replaces an explicit selection', async () => {
    const { trace, models } = await run({ selected_model: 'openai/gpt-4.1-mini', generator_model: 'meta-llama/llama-3.3-70b-instruct' });
    expect(trace.model_route).toEqual({ tier: 'quality', rule: 'explicit_choice', selection: 'explicit' });
    expect(models).toEqual(['openai/gpt-4.1-mini']);
  });

  it('behaves as today without selected_model', async () => {
    const { trace, models } = await run({ generator_model: 'meta-llama/llama-3.3-70b-instruct' });
    expect('model_route' in trace).toBe(false);
    expect(models).toEqual(['meta-llama/llama-3.3-70b-instruct']);
    expect(trace.effective_config.generator_model).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  it('no model id handed to the generator is ever auto', async () => {
    for (const mode of ['auto', 'off']) {
      env.RAG_MODEL_ROUTING = mode;
      const { models } = await run({ selected_model: 'auto' });
      expect(models.length).toBeGreaterThan(0);
      expect(models).not.toContain('auto');
    }
  });
});

describe('eval route Auto routing on a default deployment (06.2-43, D-20 revision 1)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.RAG_PIPELINE = 'v2';
    env.RAG_QUERY_LAYER = 'true';
    env.RAG_MODEL_ROUTING = 'auto';
    delete env.RAG_ROUTING_FAST_MODEL;
    delete env.RAG_ROUTING_QUALITY_MODEL;
    // Default deployment: the MCP system is off, so the real classifier answers conversational
    delete env.NEXT_PUBLIC_MCP_SYSTEM_ENABLED;
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
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a short question with retrieved documents is generated by the fast model (conversational_lookup)', async () => {
    const { trace, models } = await run({ selected_model: 'auto' }, result(plan(), { kept: KEPT }));
    expect(trace.model_route).toEqual({ tier: 'fast', rule: 'conversational_lookup', selection: 'auto' });
    expect(models).toEqual([FAST]);
  });

  it('a long question keeps the quality model (long_query)', async () => {
    const { trace, models } = await run(
      { selected_model: 'auto' },
      result({ ...plan(), original: LONG_QUERY, standalone: LONG_QUERY }, { kept: KEPT }),
      LONG_QUERY,
    );
    expect(trace.model_route).toEqual({ tier: 'quality', rule: 'long_query', selection: 'auto' });
    expect(models).toEqual([QUALITY]);
  });

  it('no retrieved document keeps the quality model (conversational_no_hit)', async () => {
    const { trace, models } = await run({ selected_model: 'auto' }, result(plan(), { kept: [] }));
    expect(trace.model_route).toEqual({ tier: 'quality', rule: 'conversational_no_hit', selection: 'auto' });
    expect(models).toEqual([QUALITY]);
  });

  it('with routing off or an explicit selection nothing changes, hit or not', async () => {
    env.RAG_MODEL_ROUTING = 'off';
    const off = await run({ selected_model: 'auto' }, result(plan(), { kept: KEPT }));
    expect(off.trace.model_route).toEqual({ tier: 'quality', rule: 'routing_off', selection: 'auto' });
    expect(off.models).toEqual([QUALITY]);
    env.RAG_MODEL_ROUTING = 'auto';
    const explicit = await run({ selected_model: 'openai/gpt-4.1-mini' }, result(plan(), { kept: KEPT }));
    expect(explicit.trace.model_route).toEqual({ tier: 'quality', rule: 'explicit_choice', selection: 'explicit' });
    expect(explicit.models).toEqual(['openai/gpt-4.1-mini']);
  });
});
