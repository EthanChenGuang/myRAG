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

/** D-03: the original is always variant 0; the condensed standalone query follows when the rewrite changed it. */
export function buildQueryPlan(input: BuildQueryPlanInput): QueryPlan {
  const { original, gate } = input;
  const condensed = input.condensed && input.condensed !== original ? input.condensed : null;
  const variants: NonNullable<QueryPlan['variants']> = [
    { text: original, language: gate.lang, kind: 'original', sub_question_index: null, protected_ok: true },
  ];
  if (condensed) variants.push({ text: condensed, language: gate.lang, kind: 'condensed', sub_question_index: null, protected_ok: true });
  return {
    original,
    standalone: condensed ?? original,
    language: gate.lang,
    gate: gateContract(gate),
    date_range: input.dateRange ?? null,
    variants,
    sub_questions: [],
    skipped: [...(input.skipped ?? [])],
    framework: input.framework,
  };
}

/** The plan's variants in plan order, in the shape of the Phase 4 queryVariants seam. */
export function planToVariants(plan: QueryPlan): QueryVariant[] {
  return (plan.variants ?? []).map((variant) => ({
    text: variant.text,
    language: variant.language,
    kind: variant.kind,
    ...(variant.sub_question_index !== null && variant.sub_question_index !== undefined
      ? { subQuestionIndex: variant.sub_question_index }
      : {}),
  }));
}
