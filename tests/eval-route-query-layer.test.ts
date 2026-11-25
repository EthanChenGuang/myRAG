import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline } from './helpers/chat-route-fakes';
import { RagTraceSchema } from '@/lib/rag-eval/contracts.generated';
import { queryLayerOverrides } from '@/lib/rag/query/run-layer';

const SECRET = 'b'.repeat(48);
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

const ORIGINAL = 'How do the alpha module and the beta module compare?';
const SUB_A = 'What does the alpha module do?';
const SUB_B = 'What does the beta module do?';

function stage(name: string, status: string, extra: Record<string, unknown> = {}) {
  return { name, status, startedAt: 0, endedAt: 1, latency_ms: 1, candidates_in: 0, candidates_out: 0, rules: [], ...extra };
}

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [
      {
        chunk_id: 'chunk-1',
        document_id: 'doc-1',
        content: 'A neutral synthetic chunk about the alpha module.',
        similarity: 0.8,
        metadata: null,
        temporal_score: 0,
        financial_score: 0,
        final_score: 0.8,
        match_reason: 'similarity',
        fused_score: 0.03,
        legs: { 'dense:0': 1 },
        language: 'en',
      },
    ],
    context: 'A neutral synthetic chunk about the alpha module.',
    usedDocuments: [{ id: 'doc-1', name: 'alpha.md', filename: 'alpha.md', similarity: 0.8 }],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: [stage('search', 'ok', { detail: 'fake' }), stage('assemble', 'ok')],
    traceId: 'trace-stub',
    queryContext: QUERY_CONTEXT,
    retrievalConfigHash: 'e'.repeat(64),
    queryLanguage: 'en',
    refusal: null,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    original: ORIGINAL,
    standalone: ORIGINAL,
    language: 'en',
    gate: {
      rewrite: true,
      transforms: ['decompose', 'expand'],
      reasons: ['R3_COMPOUND', 'R4_SHORT_VAGUE'],
      lang: 'en',
      protected_tokens: [],
      skip_retrieval: false,
    },
    date_range: null,
    variants: [
      { text: ORIGINAL, language: 'en', kind: 'original', sub_question_index: null, protected_ok: true },
      { text: SUB_A, language: 'en', kind: 'sub_question', sub_question_index: 0, protected_ok: true },
      { text: SUB_B, language: 'en', kind: 'sub_question', sub_question_index: 1, protected_ok: true },
    ],
    sub_questions: [SUB_A, SUB_B],
    skipped: [{ transform: 'hyde', reason: 'cap' }],
    framework: 'llamaindex',
    ...overrides,
  };
}

function layerResult() {
  return baseResult({
    queryPlan: plan(),
    stages: [
      stage('query_gate', 'ok'),
      stage('expand', 'disabled', { reason: 'disabled', detail: 'disabled' }),
      stage('decompose', 'ok'),
      stage('search', 'ok', { detail: 'fake' }),
      stage('assemble', 'ok'),
    ],
  });
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
    body: JSON.stringify({ schema_version: 1, query: ORIGINAL, rag_mode: 'strict', ...(options ? { options } : {}) }),
  });
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('eval route query-layer overrides (D-38)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.runSpy.mockReset();
    h.next.result = baseResult();
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

  it('maps query_layer and a single transform switch into stageOverrides.queryLayer', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ query_layer: true, query_transforms: { expand: false } }));

    expect(response.status).toBe(200);
    const input = h.runSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    expect(input.stageOverrides?.queryLayer).toEqual({ enabled: true, transforms: { expand: false } });
  });

  it('maps the framework, every transform name, the cache backend and the query params', async () => {
    const route = await loadRoute();
    const response = await route.POST(
      evalRequest({
        query_framework: 'langchain',
        query_layer: false,
        query_transforms: { condense: true, normalize_dates: false, translate: true, expand: true, hyde: false, decompose: true },
        semantic_cache: 'pgvector',
        query_params: { max_sub_questions: 2, query_budget_ms: { chat: 900 } },
      }),
    );

    expect(response.status).toBe(200);
    expect(h.runSpy.mock.calls[0][0].stageOverrides?.queryLayer).toEqual({
      enabled: false,
      framework: 'langchain',
      transforms: { condense: true, normalizeDates: false, translate: true, expand: true, hyde: false, decompose: true },
      semanticCache: 'pgvector',
      queryParams: { max_sub_questions: 2, query_budget_ms: { chat: 900 } },
    });
  });

  it('maps query_framework alone and keeps the other override fields beside it', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ query_framework: 'langchain', disabled_stages: ['hyde'] }));

    expect(response.status).toBe(200);
    const overrides = h.runSpy.mock.calls[0][0].stageOverrides;
    expect(overrides?.queryLayer).toEqual({ framework: 'langchain' });
    expect(overrides?.disabledStages).toEqual(['hyde']);
  });

  it('sends no queryLayer override when the request carries none', async () => {
    const route = await loadRoute();
    await route.POST(evalRequest());
    await route.POST(evalRequest({ query_transforms: {}, query_params: {} }));

    expect(h.runSpy.mock.calls[0][0].stageOverrides).toBeUndefined();
    expect(h.runSpy.mock.calls[1][0].stageOverrides).toBeUndefined();
  });

  it('lists every transform with its status and reason next to query_plan', async () => {
    h.next.result = layerResult();
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ query_layer: true, query_transforms: { expand: false } }));

    expect(response.status).toBe(200);
    const trace = (await response.json()) as Record<string, any>;
    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.query_plan?.sub_questions).toEqual([SUB_A, SUB_B]);
    expect(trace.query_transforms).toEqual([
      { kind: 'sub_question', text: SUB_A, transform: 'decompose', status: 'ok', reason: null },
      { kind: 'sub_question', text: SUB_B, transform: 'decompose', status: 'ok', reason: null },
      { kind: 'none', text: '', transform: 'expand', status: 'disabled', reason: 'disabled' },
      { kind: 'none', text: '', transform: 'hyde', status: 'skipped', reason: 'cap' },
    ]);
  });

  it('reports a transform that ran but whose output was discarded, and a date range', async () => {
    h.next.result = baseResult({
      queryPlan: plan({
        gate: { rewrite: true, transforms: ['condense_history', 'normalize_dates'], reasons: ['R1_PRONOUN'], lang: 'en', protected_tokens: ['AB-12'], skip_retrieval: false },
        variants: [{ text: ORIGINAL, language: 'en', kind: 'original', sub_question_index: null, protected_ok: true }],
        sub_questions: [],
        skipped: [{ transform: 'condense_history', reason: 'protected_token_lost' }],
        date_range: { from_date: '2026-01-01', to_date: '2026-01-31', include_undated: true, time_zone: 'UTC' },
      }),
      stages: [
        stage('query_gate', 'ok'),
        stage('condense', 'ok', { detail: 'discarded=protected_token_lost' }),
        stage('normalize_dates', 'ok'),
        stage('search', 'ok', { detail: 'fake' }),
        stage('assemble', 'ok'),
      ],
    });
    const route = await loadRoute();
    const trace = (await (await route.POST(evalRequest())).json()) as Record<string, any>;

    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.query_transforms).toEqual([
      { kind: 'none', text: '', transform: 'condense', status: 'ok', reason: 'protected_token_lost' },
      { kind: 'date_range', text: '2026-01-01..2026-01-31', transform: 'normalize_dates', status: 'ok', reason: null },
    ]);
  });

  it('reports a timed-out transform with the plan reason', async () => {
    h.next.result = baseResult({
      queryPlan: plan({
        variants: [{ text: ORIGINAL, language: 'en', kind: 'original', sub_question_index: null, protected_ok: true }],
        sub_questions: [],
        gate: { rewrite: true, transforms: ['expand'], reasons: ['R4_SHORT_VAGUE'], lang: 'en', protected_tokens: [], skip_retrieval: false },
        skipped: [
          { transform: 'expand', reason: 'timeout' },
          { transform: 'hyde', reason: 'error' },
        ],
      }),
      stages: [
        stage('query_gate', 'ok'),
        stage('expand', 'skipped', { reason: 'timeout' }),
        stage('hyde', 'skipped', { reason: 'failed' }),
        stage('search', 'ok', { detail: 'fake' }),
        stage('assemble', 'ok'),
      ],
    });
    const route = await loadRoute();
    const trace = (await (await route.POST(evalRequest())).json()) as Record<string, any>;

    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.query_transforms).toEqual([
      { kind: 'none', text: '', transform: 'expand', status: 'skipped', reason: 'timeout' },
      { kind: 'none', text: '', transform: 'hyde', status: 'skipped', reason: 'error' },
    ]);
  });

  it('keeps query_plan null and query_transforms empty while the layer is off, and the trace validates', async () => {
    const route = await loadRoute();
    const trace = (await (await route.POST(evalRequest({ query_layer: false }))).json()) as Record<string, any>;

    expect(RagTraceSchema.safeParse(trace).success).toBe(true);
    expect(trace.query_plan).toBeNull();
    expect(trace.query_transforms).toEqual([]);
  });

  it('applies the overrides for the eval profile only', () => {
    const overrides = { queryLayer: { enabled: true, framework: 'langchain' as const } };
    expect(queryLayerOverrides('eval', overrides)).toEqual(overrides.queryLayer);
    for (const profile of ['chat', 'embed', 'voice', 'media'] as const) {
      expect(queryLayerOverrides(profile, overrides)).toBeUndefined();
    }
  });

  it('builds the queryLayer override only in the eval route', () => {
    const apiRoot = path.resolve(__dirname, '../src/app/api');
    const builders = routeFiles(apiRoot).filter((file) => /\bqueryLayer\s*[:=]|toQueryLayerOverrides/.test(readFileSync(file, 'utf8')));
    expect(builders.map((file) => path.relative(apiRoot, file))).toEqual([path.join('internal', 'rag', 'run', 'route.ts')]);
  });
});
