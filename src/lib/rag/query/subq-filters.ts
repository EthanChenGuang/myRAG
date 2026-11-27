import type { z } from 'zod/v3';
import type { RetrievalFilterInput } from '../backend/types';
import { SubQuestionsWithFiltersSchema } from '@/lib/rag-eval/contracts.generated';

const FILTER_OR_NULL = SubQuestionsWithFiltersSchema.shape.questions.element.shape.filter;
export type SubQuestionFilter = NonNullable<z.infer<typeof FILTER_OR_NULL>>;
export type NarrowStatus = 'applied' | 'dropped_empty_intersection' | 'dropped_unknown_values';
export interface NarrowVocabulary {
  scopes: ReadonlyArray<{ dimension: string; slug: string }>;
  docTypes: readonly string[];
  languages: readonly string[];
}
export interface NarrowResult {
  status: NarrowStatus;
  filters: RetrievalFilterInput | undefined;
  applied: SubQuestionFilter | null;
}

export function parseProposedFilter(_raw: unknown): { ok: true; filter: SubQuestionFilter | null } | { ok: false } {
  return { ok: true, filter: null };
}

export function narrowFilters(base: RetrievalFilterInput | undefined, _proposed: SubQuestionFilter | null, _vocabulary: NarrowVocabulary): NarrowResult {
  return { status: 'applied', filters: base, applied: null };
}
