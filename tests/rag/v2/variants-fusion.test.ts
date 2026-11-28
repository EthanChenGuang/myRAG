import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { LEGACY_PROFILE, type EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import { embedQueriesForEvalProfile } from '@/lib/rag/embeddings/query-embedding';
import type { FusedHit, RankedList } from '@/lib/rag/fusion/rrf';
import * as rrfModule from '@/lib/rag/fusion/rrf';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { fusedToCandidate } from '@/lib/rag/v2/stages/context';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { buildQueryPlan, planToVariants } from '@/lib/rag/query/plan';
import type { QueryLayerOutcome } from '@/lib/rag/query/run-layer';
import type { GateResult } from '@/lib/rag/query/rewrite-gate';
import {
  buildQueryVariants,
  buildQueryVariantSet,
  PHASE4_VARIANT_LIMITS,
  QUERY_LAYER_VARIANT_ORDER,
  queryLayerVariantLimits,
  variantDenseTexts,
} from '@/lib/rag/query/variants';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryParamsOverrides, QueryVariant } from '@/lib/rag/types';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { runRetrieval } from '@/lib/rag';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const layer = vi.hoisted(() => ({ outcome: null as unknown }));
const rrfMock = vi.hoisted(() => ({ spy: null as unknown as Mock }));

vi.mock('@/lib/rag/fusion/rrf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/fusion/rrf')>();
  rrfMock.spy = vi.fn(actual.rrf);
  return { ...actual, rrf: rrfMock.spy, realRrf: actual.rrf };
});

vi.mock('@/lib/rag/query/run-layer', () => ({
  runQueryLayer: async () => layer.outcome,
}));

const rrfSpy = rrfMock.spy;
const realRrf = (rrfModule as unknown as { realRrf: (lists: RankedList[], k?: number) => FusedHit[] }).realRrf;

const DEFAULT_PARAMS = { max_searches: 8, max_translations: 2, max_sub_questions: 4, max_llm_variants: 2 } as const;
const LAYER_LIMITS = queryLayerVariantLimits(DEFAULT_PARAMS);

const ORIGINAL = 'How does the sample widget report its status?';
const CONDENSED = 'How does the sample widget report its status to the operator?';

function provided(subQuestions: number): QueryVariant[] {
  const subs: QueryVariant[] = Array.from({ length: subQuestions }, (_unused, index) => ({
    text: `Synthetic sub question number ${index + 1}`,
    language: 'en',
    kind: 'sub_question',
    legs: 'both',
    subQuestionIndex: index,
  }));
  return [
    { text: 'A synthetic hypothetical passage about the widget status.', language: 'en', kind: 'hyde', legs: 'dense' },
    { text: 'widget status report operator signal', language: 'en', kind: 'expanded', legs: 'both' },
    ...subs,
    { text: CONDENSED, language: 'en', kind: 'condensed', legs: 'both' },
  ];
}

const TRANSLATED = [
  { text: 'Come segnala il widget di esempio il suo stato?', language: 'it' },
  { text: '示例小部件如何报告其状态？', language: 'zh' },
];

describe('buildQueryVariantSet with the query layer limits (D-08, A-6)', () => {
  it('cap: keeps eight variants in the preference order and cuts the hyde variant last', () => {
    const { variants, cuts } = buildQueryVariantSet(ORIGINAL, 'en', TRANSLATED, provided(3), LAYER_LIMITS);
    expect(variants).toHaveLength(8);
    expect(variants.map((variant) => variant.kind)).toEqual([
      'original',
      'condensed',
      'translated',
      'translated',
      'sub_question',
      'sub_question',
      'sub_question',
      'expanded',
    ]);
    expect(cuts).toEqual([{ transform: 'hyde', reason: 'cap' }]);
  });

  it('cap: with four sub-questions the expanded and hyde variants are both cut and recorded', () => {
    const { variants, cuts } = buildQueryVariantSet(ORIGINAL, 'en', TRANSLATED, provided(4), LAYER_LIMITS);
    expect(variants).toHaveLength(8);
    expect(variants.filter((variant) => variant.kind === 'sub_question').map((variant) => variant.subQuestionIndex)).toEqual([0, 1, 2, 3]);
    expect(cuts).toEqual([
      { transform: 'expand', reason: 'cap' },
      { transform: 'hyde', reason: 'cap' },
    ]);
  });

  it('cap: applies the group limits for translations, sub-questions and generated variants', () => {
    const limits = queryLayerVariantLimits({ max_searches: 8, max_translations: 1, max_sub_questions: 1, max_llm_variants: 1 });
    const { variants, cuts } = buildQueryVariantSet(ORIGINAL, 'en', TRANSLATED, provided(2), limits);
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'condensed', 'translated', 'sub_question', 'expanded']);
    expect(cuts).toEqual([
      { transform: 'translate', reason: 'cap' },
      { transform: 'decompose', reason: 'cap' },
      { transform: 'hyde', reason: 'cap' },
    ]);
  });

  it('cap: follows max_searches from the query params', () => {
    const limits = queryLayerVariantLimits({ ...DEFAULT_PARAMS, max_searches: 2 });
    const { variants, cuts } = buildQueryVariantSet(ORIGINAL, 'en', TRANSLATED, provided(1), limits);
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'condensed']);
    expect(cuts.map((cut) => cut.transform)).toEqual(['translate', 'translate', 'decompose', 'expand', 'hyde']);
    expect(cuts.every((cut) => cut.reason === 'cap')).toBe(true);
  });

  it('keeps the first of two variants with the same text after normalization and records no cut for it', () => {
    const duplicate: QueryVariant = { text: `  ${CONDENSED.toUpperCase()}  `, language: 'en', kind: 'expanded', legs: 'both' };
    const { variants, cuts } = buildQueryVariantSet(ORIGINAL, 'en', [], [duplicate, { text: CONDENSED, language: 'en', kind: 'condensed' }], LAYER_LIMITS);
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'condensed']);
    expect(cuts).toEqual([]);
  });

  it('carries the legs, the language and the sub-question index of each variant', () => {
    const { variants } = buildQueryVariantSet(ORIGINAL, 'en', TRANSLATED.slice(0, 1), provided(1), LAYER_LIMITS);
    const byKind = Object.fromEntries(variants.map((variant) => [variant.kind, variant]));
    expect(byKind.hyde?.legs).toBe('dense');
    expect(byKind.expanded?.legs).toBe('both');
    expect(byKind.translated).toEqual({ text: TRANSLATED[0]!.text, language: 'it', kind: 'translated' });
    expect(byKind.sub_question?.subQuestionIndex).toBe(0);
  });

  it('never lets a supplied variant replace the original', () => {
    const { variants } = buildQueryVariantSet(ORIGINAL, 'en', [], [{ text: 'Another synthetic text', language: 'en', kind: 'original' }], LAYER_LIMITS);
    expect(variants).toEqual([{ text: ORIGINAL, language: 'en', kind: 'original' }]);
  });

  it('exposes the preference order with the original first', () => {
    expect(QUERY_LAYER_VARIANT_ORDER[0]).toBe('original');
    expect(LAYER_LIMITS.cap).toBe(8);
  });
});

describe('buildQueryVariants with the layer off (Phase 4 cap)', () => {
  it('cap: keeps the Phase 4 cap of three and the caller order', () => {
    expect(PHASE4_VARIANT_LIMITS.cap).toBe(3);
    const variants = buildQueryVariants(ORIGINAL, 'en', TRANSLATED, provided(1));
    expect(variants.map((variant) => variant.kind)).toEqual(['original', 'hyde', 'expanded']);
  });
});

function gate(): GateResult {
  return { rewrite: true, transforms: ['condense_history'], reasons: ['history'], lang: 'en', protectedTokens: [] } as unknown as GateResult;
}

describe('planToVariants', () => {
  it('maps hyde to the dense leg, every other kind to both legs and keeps the sub-question index', () => {
    const plan: QueryPlan = {
      ...buildQueryPlan({ original: ORIGINAL, gate: gate(), framework: 'llamaindex', condensed: CONDENSED }),
    };
    plan.variants = [
      ...(plan.variants ?? []),
      { text: 'Synthetic sub question', language: 'en', kind: 'sub_question', sub_question_index: 1, protected_ok: true },
      { text: 'A synthetic passage.', language: 'en', kind: 'hyde', sub_question_index: null, protected_ok: true },
    ];
    expect(planToVariants(plan)).toEqual([
      { text: ORIGINAL, language: 'en', kind: 'original', legs: 'both' },
      { text: CONDENSED, language: 'en', kind: 'condensed', legs: 'both' },
      { text: 'Synthetic sub question', language: 'en', kind: 'sub_question', legs: 'both', subQuestionIndex: 1 },
      { text: 'A synthetic passage.', language: 'en', kind: 'hyde', legs: 'dense' },
    ]);
  });
});

describe('planToVariants with a relative-date range (D-11)', () => {
  const RANGE = { from_date: '2025-01-01', to_date: '2025-12-31', include_undated: true, time_zone: 'UTC' };

  function datedPlan(): QueryPlan {
    const plan = buildQueryPlan({ original: ORIGINAL, gate: gate(), framework: 'llamaindex', condensed: CONDENSED, dateRange: RANGE });
    plan.variants = [
      ...(plan.variants ?? []),
      { text: 'Synthetic expansion', language: 'en', kind: 'expanded', sub_question_index: null, protected_ok: true },
      { text: 'Synthetic sub question', language: 'en', kind: 'sub_question', sub_question_index: 0, protected_ok: true },
      { text: 'A synthetic passage.', language: 'en', kind: 'hyde', sub_question_index: null, protected_ok: true },
    ];
    return plan;
  }

  it('appends the absolute dates to the dense text of the original and condensed variants only', () => {
    const variants = planToVariants(datedPlan());
    expect(variants).toEqual([
      { text: ORIGINAL, language: 'en', kind: 'original', legs: 'both', denseText: `${ORIGINAL} (2025-01-01 to 2025-12-31)` },
      { text: CONDENSED, language: 'en', kind: 'condensed', legs: 'both', denseText: `${CONDENSED} (2025-01-01 to 2025-12-31)` },
      { text: 'Synthetic expansion', language: 'en', kind: 'expanded', legs: 'both' },
      { text: 'Synthetic sub question', language: 'en', kind: 'sub_question', legs: 'both', subQuestionIndex: 0 },
      { text: 'A synthetic passage.', language: 'en', kind: 'hyde', legs: 'dense' },
    ]);
    expect(variantDenseTexts(variants)).toEqual([
      `${ORIGINAL} (2025-01-01 to 2025-12-31)`,
      `${CONDENSED} (2025-01-01 to 2025-12-31)`,
      'Synthetic expansion',
      'Synthetic sub question',
      'A synthetic passage.',
    ]);
  });

  it('keeps the lexical text unchanged: text never carries the suffix', () => {
    for (const variant of planToVariants(datedPlan())) expect(variant.text).not.toContain('2025-01-01');
  });

  it('sets no dense text without a range', () => {
    const plan = buildQueryPlan({ original: ORIGINAL, gate: gate(), framework: 'llamaindex', condensed: CONDENSED });
    for (const variant of planToVariants(plan)) expect(Object.keys(variant)).not.toContain('denseText');
  });
});

describe('runQueryStages with the query layer on', () => {
  const scope = mintScope('single', null, null);

  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('cap: searches at most max_searches variants and adds every cut to the plan skipped list', async () => {
    const plan = buildQueryPlan({
      original: ORIGINAL,
      gate: gate(),
      framework: 'llamaindex',
      condensed: CONDENSED,
      skipped: [{ transform: 'normalize_dates', reason: 'timeout' }],
    });
    const outcome: QueryLayerOutcome = {
      plan,
      variants: [...planToVariants(plan), ...provided(4)],
      dateRange: null,
      handledTranslate: false,
      shortCircuit: null,
    };
    layer.outcome = outcome;
    const env = { RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' };
    installDeps({ ragEnv: () => env });
    const config = loadRagConfig(env);
    expect(config.queryLayer.enabled).toBe(true);
    const out = await runQueryStages({
      input: { scope, query: ORIGINAL, profile: 'eval', signal: new AbortController().signal },
      scope,
      config,
      profile: 'eval',
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
      stageOverrides: { queryLayer: { queryParams: { max_searches: 5 } as QueryParamsOverrides } },
    });
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original', 'condensed', 'sub_question', 'sub_question', 'sub_question']);
    expect(out.queryLayer?.plan?.skipped).toEqual([
      { transform: 'normalize_dates', reason: 'timeout' },
      { transform: 'decompose', reason: 'cap' },
      { transform: 'expand', reason: 'cap' },
      { transform: 'hyde', reason: 'cap' },
    ]);
    expect(plan.skipped).toEqual([{ transform: 'normalize_dates', reason: 'timeout' }]);
  });
});

const searchScope = mintScope('single', null, null);

const FIVE: QueryVariant[] = [
  { text: ORIGINAL, language: 'en', kind: 'original' },
  { text: CONDENSED, language: 'en', kind: 'condensed', legs: 'both' },
  { text: TRANSLATED[0]!.text, language: 'it', kind: 'translated' },
  { text: 'widget status report operator signal', language: 'en', kind: 'expanded', legs: 'both' },
  {
    text: 'A synthetic hypothetical passage about the widget status.',
    denseText: 'A synthetic hypothetical passage about the widget status, dense form.',
    language: 'en',
    kind: 'hyde',
    legs: 'dense',
  },
];

/** One distinct unit vector per variant, so a backend call can be traced back to its variant. */
function vectorFor(index: number): number[] {
  return Array.from({ length: FIVE.length }, (_unused, position) => (position === index ? 1 : 0));
}

const SIMILARITY_BY_VARIANT = [0.5, 0.7, 0.6, 0.65, 0.99];

function variantIndexOf(req: BackendSearchRequest): number {
  return req.denseVector?.indexOf(1) ?? -1;
}

function fiveVariantBackend(calls: BackendSearchRequest[], state: { started: number; resolvedBeforeAllStarted: boolean }): RetrievalBackend {
  let resolved = 0;
  return {
    id: 'pgvector',
    async search(req) {
      calls.push(req);
      state.started += 1;
      if (resolved > 0 && state.started <= FIVE.length) state.resolvedBeforeAllStarted = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 15);
        req.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(req.signal.reason);
          },
          { once: true },
        );
      });
      resolved += 1;
      const index = variantIndexOf(req);
      const similarity = SIMILARITY_BY_VARIANT[index] ?? 0;
      return {
        dense: [
          hit('shared', { rank: index === 4 ? 2 : 1, similarity }),
          hit(`dense-only-${index}`, { rank: index === 4 ? 1 : 2, similarity: similarity - 0.01 }),
        ],
        lexical: req.lexicalTokens.length > 0 ? [hit(`lexical-only-${index}`, { rank: 1, lexicalScore: 1 })] : [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function searchConfig() {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
}

async function searchFive(
  calls: BackendSearchRequest[],
  state: { started: number; resolvedBeforeAllStarted: boolean },
  options: { trackStandalone?: boolean; variants?: QueryVariant[]; signal?: AbortSignal } = {},
) {
  const variants = options.variants ?? FIVE;
  setRetrievalBackendForTests(fiveVariantBackend(calls, state));
  installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
  await verifyV2Startup();
  const config = searchConfig();
  const signal = options.signal ?? new AbortController().signal;
  return runSearchStages({
    input: { scope: searchScope, query: ORIGINAL, profile: 'eval', signal },
    scope: searchScope,
    config,
    profile: 'eval',
    params: effectiveRetrievalParams('eval', config, null),
    embedding: { vector: vectorFor(0), profile: null },
    variantEmbeddings: variants.map((variant) => ({ vector: vectorFor(FIVE.indexOf(variant)), profile: null })),
    variants,
    signal,
    collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    ...(options.trackStandalone !== undefined ? { trackStandalone: options.trackStandalone } : {}),
  });
}

describe('one embedding batch for every variant (D-06)', () => {
  const batchProfile: EmbeddingProfile = {
    ...LEGACY_PROFILE,
    id: 'synthetic-batch-3',
    provider: 'voyage',
    model: 'voyage-4-large',
    dims: 5,
    storage: 'halfvec',
  };

  beforeEach(() => uninstallDeps());
  afterEach(() => uninstallDeps());

  it('embeds the dense text of each variant, the text when it has none', () => {
    expect(variantDenseTexts(FIVE)).toEqual([...FIVE.slice(0, 4).map((variant) => variant.text), FIVE[4]!.denseText]);
  });

  it('sends the five dense texts in exactly one provider batch call', async () => {
    const batch = vi.fn(async (texts: string[]) => texts.map((_text, index) => ({ vector: vectorFor(index), model: 'voyage-4-large' })));
    const single = vi.fn(async () => ({ vector: vectorFor(0), model: 'voyage-4-large' }));
    installDeps({ profileBatchEmbedder: batch, profileEmbedder: single });
    const out = await embedQueriesForEvalProfile(variantDenseTexts(FIVE), new AbortController().signal, batchProfile);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toEqual(variantDenseTexts(FIVE));
    expect(single).not.toHaveBeenCalled();
    expect(out).toHaveLength(5);
  });
});

describe('runSearchStages with query-layer variants (D-06, P-6)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    rrfSpy.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('starts all five backend calls before any resolves, under one shared signal', async () => {
    const calls: BackendSearchRequest[] = [];
    const state = { started: 0, resolvedBeforeAllStarted: false };
    await searchFive(calls, state);
    expect(calls).toHaveLength(5);
    expect(state.resolvedBeforeAllStarted).toBe(false);
    expect(new Set(calls.map((call) => call.signal)).size).toBe(1);
  });

  it('an abort cancels every variant call', async () => {
    const calls: BackendSearchRequest[] = [];
    const controller = new AbortController();
    const run = searchFive(calls, { started: 0, resolvedBeforeAllStarted: false }, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(run).rejects.toMatchObject({ reason: 'aborted' });
    expect(calls.every((call) => call.signal.aborted)).toBe(true);
  });

  it('sends no lexical tokens for the hyde variant and keeps the translated language restriction', async () => {
    const calls: BackendSearchRequest[] = [];
    await searchFive(calls, { started: 0, resolvedBeforeAllStarted: false });
    const byVariant = new Map(calls.map((call) => [FIVE[variantIndexOf(call)]!.kind, call]));
    expect(byVariant.get('hyde')?.lexicalTokens).toEqual([]);
    expect(byVariant.get('hyde')?.lexicalLanguages).toBeNull();
    expect(byVariant.get('translated')?.lexicalLanguages).toEqual(['it']);
    for (const kind of ['original', 'condensed', 'translated', 'expanded'] as const) {
      expect(byVariant.get(kind)?.lexicalTokens.length).toBeGreaterThan(0);
    }
  });

  it('fuses once with the shared rrf, with dense:hyde and no lexical:hyde list', async () => {
    const calls: BackendSearchRequest[] = [];
    const output = await searchFive(calls, { started: 0, resolvedBeforeAllStarted: false });
    expect(rrfSpy).toHaveBeenCalledTimes(1);
    const listIds = (rrfSpy.mock.calls[0]?.[0] as RankedList[]).map((list) => list.id).sort();
    expect(listIds).toEqual(['dense:0', 'dense:1', 'dense:2', 'dense:3', 'dense:4', 'lexical:0', 'lexical:1', 'lexical:2', 'lexical:3']);
    const expected = realRrf(rrfSpy.mock.calls[0]![0] as RankedList[], rrfSpy.mock.calls[0]![1] as number).map((row) => row.hit.chunkId);
    expect(output.fusedHits.map((row) => row.hit.chunkId)).toEqual(expected.slice(0, output.fusedHits.length));
  });

  it('sets standaloneSimilarity from the condensed dense list, never from hyde, expanded or translated', async () => {
    const output = await searchFive([], { started: 0, resolvedBeforeAllStarted: false }, { trackStandalone: true });
    const byId = new Map(output.fusedHits.map((row) => [row.hit.chunkId, row]));
    expect(byId.get('shared')?.standaloneSimilarity).toBe(0.7);
    expect(byId.get('dense-only-4')?.standaloneSimilarity).toBe(0);
    expect(byId.get('dense-only-3')?.standaloneSimilarity).toBe(0);
    expect(byId.get('dense-only-1')?.standaloneSimilarity).toBeCloseTo(0.69);
    const candidate = fusedToCandidate(byId.get('shared')!);
    expect(candidate.standaloneSimilarity).toBe(0.7);
  });

  it('uses the original dense list as the standalone list without a condensed variant', async () => {
    const variants = FIVE.filter((variant) => variant.kind !== 'condensed');
    const output = await searchFive([], { started: 0, resolvedBeforeAllStarted: false }, { trackStandalone: true, variants });
    const shared = output.fusedHits.find((row) => row.hit.chunkId === 'shared');
    expect(shared?.standaloneSimilarity).toBe(0.5);
  });

  it('leaves standaloneSimilarity unset with the query layer off (Phase 4 candidates unchanged)', async () => {
    const output = await searchFive([], { started: 0, resolvedBeforeAllStarted: false });
    expect(output.fusedHits.every((row) => !('standaloneSimilarity' in row))).toBe(true);
    expect('standaloneSimilarity' in fusedToCandidate(output.fusedHits[0]!)).toBe(false);
  });
});

describe('v2 pipeline with a dense-only variant', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('embeds the hyde dense text in the embed stage and searches it without lexical tokens', async () => {
    const embedded: string[] = [];
    const calls: BackendSearchRequest[] = [];
    setRetrievalBackendForTests({
      id: 'pgvector',
      async search(req) {
        calls.push(req);
        return { dense: [hit(`dense-${calls.length}`, { rank: 1, similarity: 0.9 })], lexical: [] } satisfies BackendLegs;
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    installDeps({
      adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
      embedder: async (text) => {
        embedded.push(text);
        return [0.1, 0.2, 0.3];
      },
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none' }),
    });
    await verifyV2Startup();
    const hyde = FIVE[4]!;
    const result = await runRetrieval({
      scope: searchScope,
      query: ORIGINAL,
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      queryVariants: [hyde],
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect([...embedded].sort()).toEqual([ORIGINAL, hyde.denseText!].sort());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.lexicalTokens).toEqual([]);
    expect(calls[0]?.lexicalTokens.length).toBeGreaterThan(0);
  });
});
