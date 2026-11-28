import { describe, expect, it } from 'vitest';
import type { TerminologyMatch } from '@/lib/rag-eval/contracts.generated';
import {
  buildQueryVariants,
  buildQueryVariantSet,
  MAX_QUERY_VARIANTS,
  PHASE4_VARIANT_LIMITS,
  QUERY_LAYER_VARIANT_ORDER,
  queryLayerVariantLimits,
} from '@/lib/rag/query/variants';
import { terminologyBudget } from '@/lib/rag/terminology/budget';
import { substituteCanonicals } from '@/lib/rag/terminology/expand';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';
import type { QueryVariant } from '@/lib/rag/types';

/** D-37: placeholder terms only. */
const ORIGINAL = 'what is termalpha';
const TERM_TEXT = 'what is term alpha beta';

function term(text = TERM_TEXT): QueryVariant {
  return { text, language: 'en', kind: 'terminology', legs: 'dense' };
}

function variant(kind: QueryVariant['kind'], text: string): QueryVariant {
  return { text, language: 'en', kind, legs: kind === 'hyde' ? 'dense' : 'both' };
}

function match(text: string, surface: string, canonical: string, from = 0): TerminologyMatch {
  const normalized = normalizeLexical(text);
  const start = normalized.indexOf(normalizeLexical(surface), from);
  if (start < 0) throw new Error('surface not in text');
  return {
    entry_id: '00000000-0000-4000-8000-000000000001',
    layer: 'shared',
    canonical,
    kind: 'synonym',
    language: 'any',
    surface: normalizeLexical(surface),
    start,
    end: start + normalizeLexical(surface).length,
  };
}

describe('substituteCanonicals', () => {
  it('replaces a Han surface with its canonical', () => {
    const text = normalizeLexical('关于术语甲的问题');
    expect(substituteCanonicals(text, [match(text, '术语甲', '术语甲乙丙')])).toBe('关于术语甲乙丙的问题');
  });

  it('replaces a Latin surface with its canonical', () => {
    const text = normalizeLexical(ORIGINAL);
    expect(substituteCanonicals(text, [match(text, 'termalpha', 'term alpha beta')])).toBe(TERM_TEXT);
  });

  it('replaces two matches left to right', () => {
    const text = normalizeLexical('termalpha and voce alfa');
    const matches = [match(text, 'voce alfa', 'termine alfa beta'), match(text, 'termalpha', 'term alpha beta')];
    expect(substituteCanonicals(text, matches)).toBe('term alpha beta and termine alfa beta');
  });

  it('leaves the text unchanged without matches', () => {
    expect(substituteCanonicals(normalizeLexical(ORIGINAL), [])).toBe(normalizeLexical(ORIGINAL));
  });
});

describe('buildQueryVariants with a terminology variant, without the query layer (Phase 4 rule)', () => {
  it('no terminology input keeps today\'s output', () => {
    const translated = [{ text: 'che cosa è termalpha', language: 'it' }];
    expect(buildQueryVariants(ORIGINAL, 'en', translated)).toEqual(buildQueryVariants(ORIGINAL, 'en', translated, [], PHASE4_VARIANT_LIMITS, null));
    expect(buildQueryVariantSet(ORIGINAL, 'en', translated).terminologyCut).toBe(false);
  });

  it('original plus terminology gives [original, terminology]', () => {
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], [], PHASE4_VARIANT_LIMITS, term());
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original', 'terminology']);
    expect(set.variants[1]).toMatchObject({ text: TERM_TEXT, legs: 'dense' });
    expect(set.terminologyCut).toBe(false);
  });

  it('appends terminology after the translations', () => {
    const set = buildQueryVariantSet(ORIGINAL, 'en', [{ text: 'che cosa è termalpha', language: 'it' }], [], PHASE4_VARIANT_LIMITS, term());
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original', 'translated', 'terminology']);
  });

  it('never displaces the original or a translation when the cap is full', () => {
    const translated = Array.from({ length: MAX_QUERY_VARIANTS - 1 }, (_unused, index) => ({ text: `synthetic translation ${index}`, language: 'it' }));
    const set = buildQueryVariantSet(ORIGINAL, 'en', translated, [], PHASE4_VARIANT_LIMITS, term());
    expect(set.variants).toHaveLength(MAX_QUERY_VARIANTS);
    expect(set.variants.some((entry) => entry.kind === 'terminology')).toBe(false);
    expect(set.terminologyCut).toBe(true);
    expect(set.cuts).toEqual([]);
  });

  it('drops a terminology text equal to the original by text key, without a cut', () => {
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], [], PHASE4_VARIANT_LIMITS, term(`  ${ORIGINAL.toUpperCase()} `));
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original']);
    expect(set.terminologyCut).toBe(false);
  });

  it('ignores a caller-supplied variant of kind terminology', () => {
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], [term('a caller made this up')], PHASE4_VARIANT_LIMITS);
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original']);
  });
});

describe('buildQueryVariants with the query layer (D-31)', () => {
  const PARAMS = { max_searches: 6, max_translations: 2, max_sub_questions: 2, max_llm_variants: 2 };

  it('places terminology first in the multi-query group', () => {
    expect(QUERY_LAYER_VARIANT_ORDER).toEqual(['original', 'condensed', 'translated', 'sub_question', 'terminology', 'expanded', 'hyde']);
    const provided = [variant('hyde', 'synthetic hypothetical passage'), variant('expanded', 'synthetic paraphrase one'), variant('sub_question', 'synthetic sub question')];
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], provided, queryLayerVariantLimits(PARAMS), term());
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original', 'sub_question', 'terminology', 'expanded']);
    expect(set.cuts).toEqual([{ transform: 'hyde', reason: 'cap' }]);
    expect(set.terminologyCut).toBe(false);
  });

  it('counts toward max_llm_variants and is never itself written as a plan cut', () => {
    const limits = queryLayerVariantLimits({ ...PARAMS, max_llm_variants: 0 });
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], [variant('expanded', 'synthetic paraphrase one')], limits, term());
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original']);
    expect(set.terminologyCut).toBe(true);
    expect(set.cuts).toEqual([{ transform: 'expand', reason: 'cap' }]);
  });

  it('drops an expanded output equal to the terminology text and keeps the terminology variant', () => {
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], [variant('expanded', TERM_TEXT.toUpperCase())], queryLayerVariantLimits(PARAMS), term());
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original', 'terminology']);
    expect(set.cuts).toEqual([]);
  });

  it('keeps the Phase 6 output unchanged without a terminology variant', () => {
    const provided = [variant('hyde', 'synthetic hypothetical passage'), variant('expanded', 'synthetic paraphrase one'), variant('expanded', 'synthetic paraphrase two')];
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], provided, queryLayerVariantLimits(PARAMS));
    expect(set.variants.map((entry) => entry.kind)).toEqual(['original', 'expanded', 'expanded']);
    expect(set.cuts).toEqual([{ transform: 'hyde', reason: 'cap' }]);
  });
});

describe('terminologyBudget (limits passed explicitly)', () => {
  const searches = 5;
  const places = 2;
  const candidates = [variant('hyde', 'synthetic hypothetical passage'), variant('expanded', 'synthetic paraphrase one'), term(), variant('expanded', 'synthetic paraphrase two')];

  it('reserves one search for term:0 while the protected variants leave room', () => {
    const budget = terminologyBudget({ protectedCount: searches - 2, termSearch: true, maxSearches: searches, maxMultiQuery: places, multiQuery: [] });
    expect(budget).toMatchObject({ variantCap: searches - 1, termSearch: true, search_cut: 0, variant_cut: 0 });
  });

  it('does not search term:0 when the protected variants alone fill the search limit', () => {
    const budget = terminologyBudget({ protectedCount: searches, termSearch: true, maxSearches: searches, maxMultiQuery: places, multiQuery: [term()] });
    expect(budget).toMatchObject({ variantCap: searches, termSearch: false, search_cut: 1, variant_cut: 1 });
    expect(budget.multiQuery).toEqual([]);
  });

  it('keeps the full cap when term:0 does not run', () => {
    const budget = terminologyBudget({ protectedCount: 1, termSearch: false, maxSearches: searches, maxMultiQuery: places, multiQuery: [] });
    expect(budget).toMatchObject({ variantCap: searches, termSearch: false, search_cut: 0, variant_cut: 0 });
  });

  it('fills the multi-query places with terminology first, then expanded, then hyde', () => {
    const budget = terminologyBudget({ protectedCount: 1, termSearch: true, maxSearches: searches, maxMultiQuery: places, multiQuery: candidates });
    expect(budget.multiQuery.map((entry) => entry.kind)).toEqual(['terminology', 'expanded']);
    expect(budget.multiQuery).toHaveLength(places);
    expect(budget.variant_cut).toBe(0);
  });

  it('cuts the terminology variant when there are no multi-query places', () => {
    const budget = terminologyBudget({ protectedCount: 1, termSearch: true, maxSearches: searches, maxMultiQuery: 0, multiQuery: candidates });
    expect(budget.multiQuery).toEqual([]);
    expect(budget.variant_cut).toBe(1);
  });

  it('cuts the terminology variant when the variant cap leaves no place after the protected variants', () => {
    const budget = terminologyBudget({ protectedCount: searches - 1, termSearch: true, maxSearches: searches, maxMultiQuery: places, multiQuery: candidates });
    expect(budget.variantCap).toBe(searches - 1);
    expect(budget.multiQuery).toEqual([]);
    expect(budget.variant_cut).toBe(1);
  });

  it('drops an expanded text equal to the terminology text and keeps the terminology variant', () => {
    const budget = terminologyBudget({
      protectedCount: 1,
      termSearch: false,
      maxSearches: searches,
      maxMultiQuery: places,
      multiQuery: [variant('expanded', ` ${TERM_TEXT.toUpperCase()}`), term(), variant('hyde', 'synthetic hypothetical passage')],
    });
    expect(budget.multiQuery.map((entry) => entry.kind)).toEqual(['terminology', 'hyde']);
  });

  it('agrees with buildQueryVariantSet on the final list', () => {
    const limits = { max_searches: searches, max_translations: 2, max_sub_questions: 2, max_llm_variants: places };
    const protectedVariants = [variant('sub_question', 'synthetic sub question one'), variant('sub_question', 'synthetic sub question two')];
    const multi = candidates.filter((entry) => entry.kind !== 'terminology');
    const budget = terminologyBudget({ protectedCount: 1 + protectedVariants.length, termSearch: true, maxSearches: searches, maxMultiQuery: places, multiQuery: candidates });
    const set = buildQueryVariantSet(ORIGINAL, 'en', [], [...protectedVariants, ...multi], { ...queryLayerVariantLimits(limits), cap: budget.variantCap }, term());
    expect(set.variants.filter((entry) => ['terminology', 'expanded', 'hyde'].includes(entry.kind))).toEqual(budget.multiQuery);
    expect(set.terminologyCut).toBe(budget.variant_cut === 1);
    expect(set.variants).toHaveLength(searches - 1);
  });
});
