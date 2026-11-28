import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { RunRetrievalInput, StageRecord } from '@/lib/rag/types';
import { installChatPipeline } from '../helpers/chat-route-fakes';

const FAST = 'anthropic/claude-haiku-5.5';
const QUALITY = 'anthropic/claude-sonnet-5.5';
const QUERY = 'Tell me about the alpha module';
const ENV_NAMES = [
  'NEXT_PUBLIC_EMBED_ENABLED',
  'NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS',
  'NEXT_PUBLIC_EMBED_MODEL',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'EMBED_RATE_LIMIT',
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
const DEFAULT_EMBED = 'openai/gpt-4o-mini';

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return {
    ...fakes.createChatRouteHarness(),
    runSpy: vi.fn(),
    providerIds: [] as string[],
    next: { result: null as unknown, category: 'document_search' as string },
  };
});

function modelStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'text-start', id: 'model' });
      controller.enqueue({ type: 'text-delta', id: 'model', delta: 'model stream' });
      controller.enqueue({ type: 'text-end', id: 'model' });
      controller.close();
    },
  });
}

vi.mock('@/lib/query-classifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/query-classifier')>();
  return {
    ...actual,
    classifyQuery: () => ({ needsMcp: false, confidence: 0.9, category: h.next.category, reasoningText: 'stub' }),
  };
});
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: async (params: Record<string, unknown>) => ({
    ...(await h.capture.streamText(params)),
    toUIMessageStream: () => modelStream(),
  }),
}));
vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => {
    h.providerIds.push(modelId);
    return { specificationVersion: 'v3', provider: 'fake', modelId };
  },
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
  return import('@/app/api/embed/chat/route');
}

async function embed(model: string | undefined, next: unknown = result()) {
  h.next.result = next;
  const { POST } = await loadRoute();
  const body: Record<string, unknown> = { messages: [{ role: 'user', content: QUERY }] };
  if (model !== undefined) body.model = model;
  const response = await POST(
    new NextRequest('http://localhost/api/embed/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.31' },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  await response.text();
  const input = h.runSpy.mock.calls[0]?.[0] as RunRetrievalInput | undefined;
  const stages = (input?.trace as { stages(): StageRecord[] } | undefined)?.stages() ?? [];
  return {
    input,
    streamedModels: h.capture.calls.map((call) => (call.model as { modelId?: string } | undefined)?.modelId),
    route: stages.find((stage) => stage.name === 'model_route')?.attributes,
  };
}

describe('embed route Auto model routing (06.2-35, D-19, D-20)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS = '*';
    env.NEXT_PUBLIC_EMBED_MODEL = DEFAULT_EMBED;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.EMBED_RATE_LIMIT = '100000';
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

  it('Auto with routing on streams a simple lookup with the fast model and records model_route', async () => {
    const run = await embed('auto');
    expect(run.streamedModels).toEqual([FAST]);
    expect(run.route).toEqual({ tier: 'fast', rule: 'simple_lookup', selection: 'auto' });
    expect(run.input?.cacheContext?.generatorModel).toBe(`auto|${FAST}|${QUALITY}`);
  });

  it('Auto with routing on keeps the quality model when a quality rule fires', async () => {
    const run = await embed('auto', result(plan(['R6_COMPOUND'])));
    expect(run.streamedModels).toEqual([QUALITY]);
    expect(run.route).toEqual({ tier: 'quality', rule: 'gate_compound', selection: 'auto' });
  });

  it('Auto with routing off resolves to the quality model', async () => {
    env.RAG_MODEL_ROUTING = 'off';
    const run = await embed('auto');
    expect(run.streamedModels).toEqual([QUALITY]);
    expect(run.input?.cacheContext?.generatorModel).toBe(QUALITY);
    expect(run.route).toEqual({ tier: 'quality', rule: 'routing_off', selection: 'auto' });
  });

  it('an unlisted model still falls back to the default embed model, routing on or off', async () => {
    for (const mode of ['auto', 'off']) {
      env.RAG_MODEL_ROUTING = mode;
      h.capture.reset();
      h.runSpy.mockReset();
      const run = await embed('vendor/not-a-listed-model');
      expect(run.streamedModels).toEqual([DEFAULT_EMBED]);
      expect(run.route).toBeUndefined();
    }
  });

  it('an explicit listed model is never replaced', async () => {
    const run = await embed(QUALITY);
    expect(run.streamedModels).toEqual([QUALITY]);
    expect(run.input?.cacheContext?.generatorModel).toBe(QUALITY);
    expect(run.route).toBeUndefined();
  });

  it('auto never reaches the provider', async () => {
    for (const mode of ['auto', 'off']) {
      env.RAG_MODEL_ROUTING = mode;
      h.providerIds.length = 0;
      await embed('auto');
      expect(h.providerIds.length).toBeGreaterThan(0);
      expect(h.providerIds).not.toContain('auto');
    }
  });
});
