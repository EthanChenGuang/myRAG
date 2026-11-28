import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend, RetrievalFilters } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { buildQueryPlan, planToVariants } from '@/lib/rag/query/plan';
import type { GateResult } from '@/lib/rag/query/rewrite-gate';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { applyVariantFilters, runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const ORIGINAL = 'How do the two synthetic reports compare across both periods?';
const SUB_A = 'What does the first synthetic report state?';
const SUB_B = 'What does the second synthetic report state?';
const BASE: RetrievalFilters = { currentOnly: true };

function gate(): GateResult {
  return { rewrite: true, transforms: ['decompose'], reasons: ['compound'], lang: 'en', protectedTokens: [] } as unknown as GateResult;
}

const NARROW = { date_range: { from: '2024-01-01', to: '2024-12-31' }, doc_types: ['general' as const], languages: null, scopes: null };

function filteredPlan() {
  return buildQueryPlan({
    original: ORIGINAL,
    gate: gate(),
    framework: 'llamaindex',
    subQuestions: [SUB_A, SUB_B],
    subQuestionSpecs: [
      { text: SUB_A, filter: NARROW },
      { text: SUB_B, filter: null },
    ],
    filterTrace: [
      { index: 0, status: 'applied', retried: false, retry_skipped_cap: false },
      { index: 1, status: 'applied', retried: false, retry_skipped_cap: false },
    ],
  });
}

describe('plan to variants with sub-question filters (D-08)', () => {
  it('attaches the narrowed filter and filterApplied to the filtered sub-question only', () => {
    const plan = filteredPlan();
    expect(plan.variants?.map((variant) => variant.filter_applied)).toEqual([undefined, true, undefined]);
    const variants = planToVariants(plan);
    expect(variants[1]).toEqual({
      text: SUB_A,
      language: 'en',
      kind: 'sub_question',
      legs: 'both',
      subQuestionIndex: 0,
      filters: { currentOnly: true, dateRange: { from: '2024-01-01', to: '2024-12-31' }, docTypes: ['general'] },
      filterApplied: true,
    });
    expect(variants[0]).toEqual({ text: ORIGINAL, language: 'en', kind: 'original', legs: 'both' });
    expect(variants[2]).toEqual({ text: SUB_B, language: 'en', kind: 'sub_question', legs: 'both', subQuestionIndex: 1 });
  });

  it('switch off: a plan without specs maps exactly as Phase 6', () => {
    const plan = buildQueryPlan({ original: ORIGINAL, gate: gate(), framework: 'llamaindex', subQuestions: [SUB_A, SUB_B] });
    for (const variant of plan.variants ?? []) expect(Object.keys(variant)).not.toContain('filter_applied');
    for (const variant of planToVariants(plan)) {
      expect(Object.keys(variant)).not.toContain('filters');
      expect(Object.keys(variant)).not.toContain('filterApplied');
    }
  });
});

describe('applyVariantFilters never widens the shared filters', () => {
  const variant = (filters: RetrievalFilters): QueryVariant => ({ text: SUB_A, language: 'en', kind: 'sub_question', filters, filterApplied: true });

  it('returns the shared filters for a variant without a filter', () => {
    const base: RetrievalFilters = { currentOnly: true, docTypes: ['general'] };
    expect(applyVariantFilters(base, { text: ORIGINAL, language: 'en', kind: 'original' })).toBe(base);
  });

  it('intersects dates, lists and scopes and keeps every other shared field', () => {
    const base: RetrievalFilters = {
      currentOnly: true,
      dateRange: { from: '2024-03-01', to: '2025-06-30', includeUndated: true },
      documentIds: ['doc-1', 'doc-2'],
      docTypes: ['general', 'contract_legal'],
      scopes: ['area:north', 'area:south', 'unit:alpha'],
      effectiveOn: '2026-01-01',
    };
    const out = applyVariantFilters(
      base,
      variant({
        currentOnly: true,
        dateRange: { from: '2024-01-01', to: '2024-12-31' },
        docTypes: ['general', 'invoice_receipt'],
        languages: ['en'],
        scopes: ['area:south', 'team:beta'],
      }),
    );
    expect(out).toEqual({
      currentOnly: true,
      dateRange: { from: '2024-03-01', to: '2024-12-31', includeUndated: true },
      documentIds: ['doc-1', 'doc-2'],
      docTypes: ['general'],
      languages: ['en'],
      scopes: ['area:south', 'team:beta', 'unit:alpha'],
      effectiveOn: '2026-01-01',
    });
  });

  it('an empty intersection falls back to the shared filters, never an empty search', () => {
    const base: RetrievalFilters = { currentOnly: true, docTypes: ['general'] };
    expect(applyVariantFilters(base, variant({ currentOnly: true, docTypes: ['invoice_receipt'] }))).toBe(base);
    const dated: RetrievalFilters = { currentOnly: true, dateRange: { from: '2025-01-01', to: '2025-12-31' } };
    expect(applyVariantFilters(dated, variant({ currentOnly: true, dateRange: { from: '2023-01-01', to: '2023-12-31' } }))).toBe(dated);
  });
});

type Script = (req: BackendSearchRequest, call: number) => BackendLegs;

function legs(prefix: string): BackendLegs {
  return { dense: [hit(`${prefix}-d`, { rank: 1, similarity: 0.8 })], lexical: [hit(`${prefix}-l`, { rank: 1, lexicalScore: 1 })] };
}

const EMPTY: BackendLegs = { dense: [], lexical: [] };

function recordingBackend(calls: BackendSearchRequest[], script: Script): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      calls.push(req);
      return script(req, calls.length);
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function vectorFor(index: number, size: number): number[] {
  return Array.from({ length: size }, (_unused, position) => (position === index ? 1 : 0));
}

function variantOf(req: BackendSearchRequest): number {
  return req.denseVector?.indexOf(1) ?? -1;
}

async function search(variants: QueryVariant[], script: Script, extra: { maxSearches?: number; terminology?: boolean } = {}) {
  const calls: BackendSearchRequest[] = [];
  setRetrievalBackendForTests(recordingBackend(calls, script));
  installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
  await verifyV2Startup();
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
  const signal = new AbortController().signal;
  const output = await runSearchStages({
    input: { scope, query: ORIGINAL, profile: 'eval', signal },
    scope,
    config,
    profile: 'eval',
    params: effectiveRetrievalParams('eval', config, null),
    embedding: { vector: vectorFor(0, 9), profile: null },
    variantEmbeddings: variants.map((_variant, index) => ({ vector: vectorFor(index, 9), profile: null })),
    variants,
    filters: BASE,
    signal,
    collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    ...(extra.maxSearches !== undefined ? { maxSearches: extra.maxSearches } : {}),
    ...(extra.terminology ? { terminology: { tokens: ['synthetic'], expansionWeight: 0.5, reserveSlots: 0 } } : {}),
  });
  return { calls, output };
}

const FILTERED: RetrievalFilters = { currentOnly: true, docTypes: ['general'] };

function threeVariants(): QueryVariant[] {
  return [
    { text: ORIGINAL, language: 'en', kind: 'original', legs: 'both' },
    { text: SUB_A, language: 'en', kind: 'sub_question', legs: 'both', subQuestionIndex: 0, filters: FILTERED, filterApplied: true },
    { text: SUB_B, language: 'en', kind: 'sub_question', legs: 'both', subQuestionIndex: 1 },
  ];
}

describe('search stage: per-variant filters and one retry (D-08, P-10)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('searches the filtered sub-question with its filter and every other variant with the shared filters', async () => {
    const { calls, output } = await search(threeVariants(), (req) => legs(`v${variantOf(req)}`), { maxSearches: 8 });
    expect(calls).toHaveLength(3);
    const byVariant = new Map(calls.filter((req) => req.denseVector).map((req) => [variantOf(req), req.filters]));
    expect(byVariant.get(0)).toEqual(BASE);
    expect(byVariant.get(1)).toEqual(FILTERED);
    expect(byVariant.get(2)).toEqual(BASE);
    expect(output.searchesCounted).toBe(3);
    expect(output.filterRetries).toEqual([{ subQuestionIndex: 0, retried: false, retrySkippedCap: false }]);
  });

  it('retries an empty filtered search once with the shared filters and fuses it under the same list names', async () => {
    const { calls, output } = await search(
      threeVariants(),
      (req) => (variantOf(req) === 1 && req.filters.docTypes ? EMPTY : legs(`v${variantOf(req)}${req.filters.docTypes ? '' : '-base'}`)),
      { maxSearches: 8 },
    );
    const forSub = calls.filter((req) => variantOf(req) === 1);
    expect(forSub.map((req) => req.filters)).toEqual([FILTERED, BASE]);
    expect(calls).toHaveLength(4);
    const retried = output.fusedHits.find((row) => row.hit.chunkId === 'v1-base-d');
    expect(retried?.ranks).toHaveProperty('dense:1');
    expect(output.searchesCounted).toBe(4);
    expect(output.filterRetries).toEqual([{ subQuestionIndex: 0, retried: true, retrySkippedCap: false }]);
  });

  it('skips the retry when the cap of searches is reached and records retry_skipped_cap', async () => {
    const variants: QueryVariant[] = [
      ...threeVariants(),
      ...[1, 2, 3, 4, 5].map((n): QueryVariant => ({ text: `Synthetic expansion ${n}`, language: 'en', kind: 'expanded', legs: 'both' })),
    ];
    const { calls, output } = await search(variants, (req) => (req.filters.docTypes ? EMPTY : legs(`v${variantOf(req)}`)), { maxSearches: 8 });
    expect(calls).toHaveLength(8);
    expect(output.searchesCounted).toBe(8);
    expect(output.filterRetries).toEqual([{ subQuestionIndex: 0, retried: false, retrySkippedCap: true }]);
  });

  it('counts variants and retries only; the term:0 call is not counted but leaves no room above the cap', async () => {
    const { calls, output } = await search(threeVariants(), (req) => (req.filters.docTypes ? EMPTY : legs(`v${variantOf(req)}`)), {
      maxSearches: 4,
      terminology: true,
    });
    const termCalls = calls.filter((req) => req.denseVector === null);
    expect(termCalls).toHaveLength(1);
    expect(calls).toHaveLength(4);
    expect(output.searchesCounted).toBe(3);
    expect(output.filterRetries).toEqual([{ subQuestionIndex: 0, retried: false, retrySkippedCap: true }]);
  });

  it('switch off: variants without filters send the Phase 6 requests and report no retries', async () => {
    const plain = threeVariants().map(({ filters: _f, filterApplied: _a, ...variant }) => variant);
    const { calls, output } = await search(plain, (req) => legs(`v${variantOf(req)}`));
    expect(calls).toHaveLength(3);
    for (const req of calls) expect(req.filters).toBe(BASE);
    expect(output.filterRetries).toBeUndefined();
    expect(output.searchesCounted).toBeUndefined();
  });
});
