import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRetrievalInput } from '@/lib/rag/types';
import type { StageRecord } from '@/lib/rag/types';
import { chatRequest, installChatPipeline, readSse } from '../helpers/chat-route-fakes';

const FAST = 'anthropic/claude-haiku-5.5';
const QUALITY = 'anthropic/claude-sonnet-5.5';
const EXPLICIT = 'openai/gpt-4o-mini';
const QUERY = 'Tell me about the alpha module';
const ENV_NAMES = [
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_PIPELINE',
  'RAG_QUERY_LAYER',
  'RAG_MODEL_ROUTING',
  'RAG_ROUTING_FAST_MODEL',
  'RAG_ROUTING_QUALITY_MODEL',
  'RAG_SEMANTIC_CACHE',
  'RAG_SUPPORTED_LANGUAGES',
  'RAG_PRIMARY_LANGUAGE',
] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    runSpy: vi.fn(),
    providerIds: [] as string[],
    next: { result: null as unknown, category: 'document_search' as string },
  };
});

vi.mock('@/lib/query-classifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/query-classifier')>();
  return {
    ...actual,
    classifyQuery: () => ({ needsMcp: false, confidence: 0.9, category: h.next.category, reasoningText: 'stub' }),
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
  createOpenRouter: () => (modelId: string) => {
    h.providerIds.push(modelId);
    return { specificationVersion: 'v3', provider: 'fake', modelId };
  },
}));
vi.mock('exa-js', () => ({ default: h.exa.Exa }));

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

function result(queryPlan: unknown = plan()) {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [],
    context: 'The alpha module stores neutral sample values.',
    usedDocuments: [{ id: 'doc-1', name: 'alpha.md', filename: 'alpha.md', similarity: 0.8 }],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
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
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: RunRetrievalInput) => {
        h.runSpy(input);
        return Promise.resolve(h.next.result);
      },
    };
  });
  await installChatPipeline(h);
  return import('@/app/api/chat/route');
}

async function chat(model: string | undefined, next: unknown = result()) {
  h.next.result = next;
  const { POST } = await loadRoute();
  const settings: Record<string, unknown> = { webSearch: false };
  if (model !== undefined) settings.model = model;
  const response = await POST(chatRequest({ messages: [{ role: 'user', content: QUERY }], data: { ragMode: 'balanced', settings } }));
  await readSse(response);
  const input = h.runSpy.mock.calls[0]?.[0] as RunRetrievalInput | undefined;
  const stages = (input?.trace as { stages(): StageRecord[] } | undefined)?.stages() ?? [];
  const route = stages.find((stage) => stage.name === 'model_route');
  return {
    input,
    streamedModels: h.capture.calls.map((call) => (call.model as { modelId?: string } | undefined)?.modelId),
    route: route ? (route as unknown as { attributes?: Record<string, unknown> }).attributes : undefined,
  };
}

describe('chat route Auto model routing (06.2-35, D-19, D-20, D-35)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.RAG_PIPELINE = 'v2';
    env.RAG_QUERY_LAYER = 'true';
    env.RAG_MODEL_ROUTING = 'auto';
    env.RAG_SEMANTIC_CACHE = 'pgvector';
    env.RAG_SUPPORTED_LANGUAGES = 'en,zh,it';
    env.RAG_PRIMARY_LANGUAGE = 'en';
    delete env.RAG_ROUTING_FAST_MODEL;
    delete env.RAG_ROUTING_QUALITY_MODEL;
    h.capture.reset();
    h.runSpy.mockReset();
    h.providerIds.length = 0;
    h.next.category = 'document_search';
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

  it('an explicit model streams unchanged with routing on and records no model_route', async () => {
    const run = await chat(EXPLICIT);
    expect(run.streamedModels).toEqual([EXPLICIT]);
    expect(run.input?.options?.isGPTModel).toBe(true);
    expect(run.input?.cacheContext?.generatorModel).toBe(EXPLICIT);
    expect(run.route).toBeUndefined();
  });

  it('an explicit model gives the same retrieval input and provider call with routing on or off', async () => {
    const on = await chat('openai/gpt-4.1-mini');
    const onInput = { ...on.input, trace: undefined, signal: undefined };
    h.capture.reset();
    h.runSpy.mockReset();
    env.RAG_MODEL_ROUTING = 'off';
    const off = await chat('openai/gpt-4.1-mini');
    expect(off.streamedModels).toEqual(on.streamedModels);
    expect({ ...off.input, trace: undefined, signal: undefined }).toEqual(onInput);
    expect(off.route).toBeUndefined();
  });

  it('Auto with routing off resolves to the quality model everywhere', async () => {
    env.RAG_MODEL_ROUTING = 'off';
    const run = await chat('auto');
    expect(run.streamedModels).toEqual([QUALITY]);
    expect(run.input?.cacheContext?.generatorModel).toBe(QUALITY);
    expect(run.route).toEqual({ tier: 'quality', rule: 'routing_off', selection: 'auto' });
  });

  it('Auto with routing on streams a simple lookup with the fast model and records model_route', async () => {
    const run = await chat('auto');
    expect(run.streamedModels).toEqual([FAST]);
    expect(run.route).toEqual({ tier: 'fast', rule: 'simple_lookup', selection: 'auto' });
  });

  it('Auto with routing on keeps the quality model when a quality rule fires', async () => {
    const run = await chat('auto', result(plan(['R3_COMPARISON'])));
    expect(run.streamedModels).toEqual([QUALITY]);
    expect(run.route).toEqual({ tier: 'quality', rule: 'gate_comparison', selection: 'auto' });
  });

  it('Auto with routing on keeps the quality model when the classifier does not say document_search', async () => {
    h.next.category = 'conversational';
    const run = await chat('auto');
    expect(run.streamedModels).toEqual([QUALITY]);
    expect(run.route).toEqual({ tier: 'quality', rule: 'not_document_search', selection: 'auto' });
  });

  it('a routable Auto turn keys the cache by the selection and both routing ids', async () => {
    const run = await chat('auto');
    expect(run.input?.cacheContext?.generatorModel).toBe(`auto|${FAST}|${QUALITY}`);
  });

  it('auto never reaches the provider, the retrieval options or the stream call', async () => {
    for (const mode of ['auto', 'off']) {
      env.RAG_MODEL_ROUTING = mode;
      h.capture.reset();
      h.runSpy.mockReset();
      h.providerIds.length = 0;
      const run = await chat('auto');
      expect(run.streamedModels.length).toBe(1);
      expect(run.streamedModels).not.toContain('auto');
      expect(h.providerIds.length).toBeGreaterThan(0);
      expect(h.providerIds).not.toContain('auto');
      expect(run.input?.options?.isGPTModel).toBe(false);
    }
  });
});
