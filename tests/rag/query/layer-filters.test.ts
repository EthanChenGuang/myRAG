import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalFilters } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { mergeLayerDateRange } from '@/lib/rag/query/layer-filters';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { runQueryStages } from '@/lib/rag/v2/stages/query';

vi.mock('@/lib/rag/query/run-layer', () => ({
  runQueryLayer: async () => ({
    plan: null,
    variants: [
      { text: 'What changed last year?', language: 'en', kind: 'original' },
      { text: 'What changed in the sample product during 2025?', language: 'en', kind: 'condensed' },
    ],
    dateRange: { from: '2025-01-01', to: '2025-12-31', includeUndated: true, timeZone: 'UTC' },
    handledTranslate: true,
    shortCircuit: null,
  }),
}));

const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LAST_YEAR = { from: '2025-01-01', to: '2025-12-31', includeUndated: true };

function base(extra: Partial<RetrievalFilters> = {}): RetrievalFilters {
  return { currentOnly: true, documentIds: [DOC], docTypes: ['general'], languages: ['en'], sources: ['upload'], ...extra };
}

function untouched(result: RetrievalFilters, input: RetrievalFilters) {
  const { dateRange: _a, ...restResult } = result;
  const { dateRange: _b, ...restInput } = input;
  expect(restResult).toEqual(restInput);
  expect(result.currentOnly).toBe(true);
}

describe('mergeLayerDateRange', () => {
  it('returns the filters unchanged without a layer range', () => {
    const input = base({ dateRange: { from: '2024-01-01', to: '2024-12-31' } });
    expect(mergeLayerDateRange(input, null)).toEqual(input);
  });

  it('sets the relative range with includeUndated when no explicit range exists', () => {
    const input = base();
    const result = mergeLayerDateRange(input, LAST_YEAR);
    expect(result.dateRange).toEqual({ from: '2025-01-01', to: '2025-12-31', includeUndated: true });
    untouched(result, input);
    expect(input.dateRange).toBeUndefined();
  });

  it('intersects with an explicit range and keeps undated rows out, as the explicit range does', () => {
    const input = base({ dateRange: { from: '2025-03-01', to: '2026-06-30' } });
    const result = mergeLayerDateRange(input, LAST_YEAR);
    expect(result.dateRange).toEqual({ from: '2025-03-01', to: '2025-12-31', includeUndated: false });
    untouched(result, input);
    expect(input.dateRange).toEqual({ from: '2025-03-01', to: '2026-06-30' });
  });

  it('intersects with an open-ended explicit range', () => {
    expect(mergeLayerDateRange(base({ dateRange: { from: '2025-06-01' } }), LAST_YEAR).dateRange).toEqual({
      from: '2025-06-01',
      to: '2025-12-31',
      includeUndated: false,
    });
    expect(mergeLayerDateRange(base({ dateRange: { to: '2025-02-15' } }), LAST_YEAR).dateRange).toEqual({
      from: '2025-01-01',
      to: '2025-02-15',
      includeUndated: false,
    });
  });

  it('gives an empty range that matches nothing for disjoint ranges, never a wider one', () => {
    const explicit = { from: '2023-01-01', to: '2023-12-31' };
    const result = mergeLayerDateRange(base({ dateRange: explicit }), LAST_YEAR);
    const range = result.dateRange!;
    expect(range.includeUndated).toBe(false);
    expect(range.from! > range.to!).toBe(true);
    expect(range.from! >= explicit.from && range.from! >= LAST_YEAR.from).toBe(true);
    expect(range.to! <= explicit.to && range.to! <= LAST_YEAR.to).toBe(true);
  });

  it('keeps an explicit includeUndated only when both sides allow undated rows', () => {
    const input = base({ dateRange: { from: '2025-01-01', to: '2025-06-30', includeUndated: true } });
    expect(mergeLayerDateRange(input, LAST_YEAR).dateRange).toEqual({ from: '2025-01-01', to: '2025-06-30', includeUndated: true });
    expect(mergeLayerDateRange(input, { ...LAST_YEAR, includeUndated: false }).dateRange?.includeUndated).toBe(false);
  });

  it('ignores a malformed layer range instead of widening', () => {
    const input = base({ dateRange: { from: '2025-01-01', to: '2025-06-30' } });
    expect(mergeLayerDateRange(input, { from: 'not-a-date', to: '2025-12-31', includeUndated: true })).toEqual(input);
    expect(mergeLayerDateRange(input, { from: '2025-12-31', to: '2025-01-01', includeUndated: true })).toEqual(input);
  });
});

describe('v2 query stage consumes the layer outcome', () => {
  afterEach(() => resetRagConfigForTests());

  it('narrows the filters with the outcome range, adds its variants and stands the Phase 4 translate stage down', async () => {
    resetRagConfigForTests();
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true', RAG_LEXICAL_TRANSLATION: 'true' });
    const scope = mintScope('single', null, null);
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const signal = new AbortController().signal;
    const out = await runQueryStages({
      input: {
        scope,
        query: 'What changed last year?',
        profile: 'eval',
        signal,
        retrievalFilters: { dateRange: { from: '2025-06-01', to: '2026-03-31' }, docTypes: ['general'] },
      },
      scope,
      config,
      profile: 'eval',
      signal,
      collector,
    });
    expect(out.filters).toEqual({
      currentOnly: true,
      docTypes: ['general'],
      dateRange: { from: '2025-06-01', to: '2025-12-31', includeUndated: false },
    });
    expect(out.variants.map((variant) => variant.kind)).toEqual(['original', 'condensed']);
    const translate = collector.stages().find((row) => row.name === 'translate');
    expect(translate).toMatchObject({ status: 'disabled', detail: 'handled_by_query_layer' });
    expect(out.queryLayer?.handledTranslate).toBe(true);
  });
});
