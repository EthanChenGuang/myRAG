import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '@/lib/rag/query/variants';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const layer = vi.hoisted(() => ({ outcome: null as unknown }));

vi.mock('@/lib/rag/query/run-layer', () => ({
  runQueryLayer: async () => layer.outcome,
}));

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
      stageOverrides: { queryLayer: { queryParams: { max_searches: 5 } } },
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
