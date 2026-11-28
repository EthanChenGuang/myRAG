import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { QueryFramework } from '../config';
import type { RetrievalFilters } from '../backend/types';
import type { QueryVariant } from '../types';
import { denseDateSuffix } from './dates';
import type { GateResult } from './rewrite-gate';

export type SkippedTransform = NonNullable<QueryPlan['skipped']>[number];

export interface BuildQueryPlanInput {
  original: string;
  gate: GateResult;
  framework: QueryFramework;
  /** The condensed standalone query; null or equal to the original when nothing was rewritten. */
  condensed?: string | null;
  /** D-23: previous standalone query + newline + follow-up, when condense was skipped; searched right after the original. */
  historyFallback?: string | null;
  skipped?: readonly SkippedTransform[];
  dateRange?: QueryPlan['date_range'];
  /** Translated variants in target order (D-23, at most two). */
  translated?: ReadonlyArray<{ text: string; language: QueryPlan['language'] }>;
  /** Expansion variants in model order (D-08 budget already applied). */
  expanded?: readonly string[];
  /** The HyDE passage and whether it kept the protected tokens. */
  hyde?: { text: string; protectedOk: boolean } | null;
  /** Sub-questions in order, at most 4 (D-08). */
  subQuestions?: readonly string[];
  /** D-04: the completeness counts; absent while the check did not run, so the plan is unchanged with the switch off. */
  completeness?: QueryPlan['completeness'];
  /** D-05: the narrowed specs (texts equal subQuestions); absent with RAG_QUERY_SUBQ_FILTERS off, so the plan is unchanged. */
  subQuestionSpecs?: QueryPlan['sub_question_specs'];
  /** D-06: one entry per spec with the switch on; with it off only when a returned filter was stripped. */
  filterTrace?: QueryPlan['filter_trace'];
}

/** QueryPlan.variants holds at most 8 entries (D-08 hard cap of 8 searches). */
const MAX_PLAN_VARIANTS = 8;

function variantKey(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function gateContract(gate: GateResult): QueryPlan['gate'] {
  return {
    rewrite: gate.rewrite,
    transforms: [...gate.transforms],
    reasons: [...gate.reasons],
    lang: gate.lang,
    protected_tokens: [...gate.protectedTokens],
    skip_retrieval: gate.skipRetrieval === true,
  };
}

/**
 * D-03: the original is always variant 0; the condensed standalone query follows when the rewrite changed it (or, D-23, the
 * history_fallback variant when condense was skipped), then the translations, the expansions, the HyDE passage and the sub-questions. Duplicates by text are dropped.
 */
export function buildQueryPlan(input: BuildQueryPlanInput): QueryPlan {
  const { original, gate } = input;
  const condensed = input.condensed && input.condensed !== original ? input.condensed : null;
  const variants: NonNullable<QueryPlan['variants']> = [
    { text: original, language: gate.lang, kind: 'original', sub_question_index: null, protected_ok: true },
  ];
  if (condensed) variants.push({ text: condensed, language: gate.lang, kind: 'condensed', sub_question_index: null, protected_ok: true });
  const seen = new Set(variants.map((variant) => variantKey(variant.text)));
  const add = (variant: NonNullable<QueryPlan['variants']>[number]) => {
    const key = variantKey(variant.text);
    if (key === '' || seen.has(key) || variants.length >= MAX_PLAN_VARIANTS) return false;
    seen.add(key);
    variants.push(variant);
    return true;
  };
  if (input.historyFallback) {
    add({ text: input.historyFallback, language: gate.lang, kind: 'history_fallback', sub_question_index: null, protected_ok: true });
  }
  for (const item of input.translated ?? []) {
    add({ text: item.text, language: item.language, kind: 'translated', sub_question_index: null, protected_ok: true });
  }
  for (const text of input.expanded ?? []) {
    add({ text, language: gate.lang, kind: 'expanded', sub_question_index: null, protected_ok: true });
  }
  if (input.hyde) {
    add({ text: input.hyde.text, language: gate.lang, kind: 'hyde', sub_question_index: null, protected_ok: input.hyde.protectedOk });
  }
  const subQuestions = (input.subQuestions ?? []).slice(0, 4);
  subQuestions.forEach((text, index) => {
    // D-08: a sub-question whose narrowed spec kept a filter is searched with it; the field is absent otherwise (Phase 6 shape).
    const filtered = input.subQuestionSpecs?.[index]?.filter ? { filter_applied: true } : {};
    add({ text, language: gate.lang, kind: 'sub_question', sub_question_index: index, protected_ok: true, ...filtered });
  });
  return {
    original,
    standalone: condensed ?? original,
    language: gate.lang,
    gate: gateContract(gate),
    date_range: input.dateRange ?? null,
    variants,
    sub_questions: [...subQuestions],
    skipped: [...(input.skipped ?? [])],
    framework: input.framework,
    ...(input.completeness ? { completeness: { ...input.completeness } } : {}),
    ...(input.subQuestionSpecs ? { sub_question_specs: input.subQuestionSpecs.slice(0, subQuestions.length).map((spec) => ({ ...spec })) } : {}),
    ...(input.filterTrace ? { filter_trace: input.filterTrace.slice(0, subQuestions.length).map((entry) => ({ ...entry })) } : {}),
  };
}

/**
 * The plan's variants in plan order, in the shape of the Phase 4 queryVariants seam; HyDE searches the dense leg only (P-6).
 * D-11: with a relative-date range the original and condensed variants embed their text plus the absolute dates; text, and
 * so the lexical tokens, stays unchanged.
 */
export function planToVariants(plan: QueryPlan): QueryVariant[] {
  const suffix = plan.date_range ? denseDateSuffix(plan.date_range.from_date, plan.date_range.to_date) : null;
  return (plan.variants ?? []).map((variant) => {
    const spec =
      variant.kind === 'sub_question' && variant.filter_applied === true && typeof variant.sub_question_index === 'number'
        ? (plan.sub_question_specs?.[variant.sub_question_index]?.filter ?? null)
        : null;
    const filters = specFilters(spec);
    const versions = spec?.versions ?? null;
    return {
      text: variant.text,
      language: variant.language,
      kind: variant.kind,
      legs: variant.kind === 'hyde' ? ('dense' as const) : ('both' as const),
      ...(variant.sub_question_index !== null && variant.sub_question_index !== undefined
        ? { subQuestionIndex: variant.sub_question_index }
        : {}),
      ...(suffix && (variant.kind === 'original' || variant.kind === 'condensed' || variant.kind === 'history_fallback')
        ? { denseText: `${variant.text} ${suffix}` }
        : {}),
      ...(filters ? { filters, filterApplied: true } : {}),
      // P-35: the spec's version scope, already bounded by the request's own; the search stage applies it to this variant only.
      ...(versions !== null ? { versionScope: versions === 'current' || versions === 'all' ? versions : { ...versions } } : {}),
    };
  });
}

type SpecFilter = NonNullable<NonNullable<QueryPlan['sub_question_specs']>[number]['filter']>;

/**
 * D-08: the narrowing fields of an applied spec (already intersected with the request filters by narrowFilters); the search stage
 * intersects them again with the shared filters in force, which supply every other field. No tenant field exists in the contract.
 */
function specFilters(filter: SpecFilter | null): RetrievalFilters | null {
  if (!filter) return null;
  const out: { -readonly [K in keyof RetrievalFilters]: RetrievalFilters[K] } = { currentOnly: true };
  if (filter.date_range) out.dateRange = { from: filter.date_range.from, to: filter.date_range.to };
  if (filter.doc_types) out.docTypes = [...filter.doc_types];
  if (filter.languages) out.languages = [...filter.languages];
  if (filter.scopes) {
    out.scopes = Object.entries(filter.scopes)
      .flatMap(([dimension, slugs]) => slugs.map((slug) => `${dimension}:${slug}`))
      .sort();
  }
  return Object.keys(out).length > 1 ? (out as RetrievalFilters) : null;
}
