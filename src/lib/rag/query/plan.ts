import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { QueryFramework } from '../config';
import type { QueryVariant } from '../types';
import type { GateResult } from './rewrite-gate';

export type SkippedTransform = NonNullable<QueryPlan['skipped']>[number];

export interface BuildQueryPlanInput {
  original: string;
  gate: GateResult;
  framework: QueryFramework;
  /** The condensed standalone query; null or equal to the original when nothing was rewritten. */
  condensed?: string | null;
  skipped?: readonly SkippedTransform[];
  dateRange?: QueryPlan['date_range'];
  /** Expansion variants in model order (D-08 budget already applied). */
  expanded?: readonly string[];
  /** The HyDE passage and whether it kept the protected tokens. */
  hyde?: { text: string; protectedOk: boolean } | null;
  /** Sub-questions in order, at most 4 (D-08). */
  subQuestions?: readonly string[];
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
 * D-03: the original is always variant 0; the condensed standalone query follows when the rewrite changed it, then the
 * expansions, the HyDE passage and the sub-questions. Duplicates by text are dropped.
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
  for (const text of input.expanded ?? []) {
    add({ text, language: gate.lang, kind: 'expanded', sub_question_index: null, protected_ok: true });
  }
  if (input.hyde) {
    add({ text: input.hyde.text, language: gate.lang, kind: 'hyde', sub_question_index: null, protected_ok: input.hyde.protectedOk });
  }
  const subQuestions = (input.subQuestions ?? []).slice(0, 4);
  subQuestions.forEach((text, index) => {
    add({ text, language: gate.lang, kind: 'sub_question', sub_question_index: index, protected_ok: true });
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
  };
}

/** The plan's variants in plan order, in the shape of the Phase 4 queryVariants seam; HyDE searches the dense leg only (P-6). */
export function planToVariants(plan: QueryPlan): QueryVariant[] {
  return (plan.variants ?? []).map((variant) => ({
    text: variant.text,
    language: variant.language,
    kind: variant.kind,
    legs: variant.kind === 'hyde' ? ('dense' as const) : ('both' as const),
    ...(variant.sub_question_index !== null && variant.sub_question_index !== undefined
      ? { subQuestionIndex: variant.sub_question_index }
      : {}),
  }));
}
