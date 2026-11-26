import { textKey } from '../query/variants';
import type { QueryVariant, QueryVariantKind } from '../types';

/** D-31: what the terminology calls may take from the request's search and multi-query limits; the limits come from the caller. */
export interface TerminologyBudgetInput {
  /** The protected variants (original, condensed, translated, sub_question) after their own limits and dedupe. */
  protectedCount: number;
  /** The multi-query candidates (terminology, expanded, hyde) in any order. */
  multiQuery: readonly QueryVariant[];
  /** Whether term:0 would run: the stage produced expansion tokens and lexical search is usable. */
  termSearch: boolean;
  /** QueryParams.max_searches in force. */
  maxSearches: number;
  /** QueryParams.max_llm_variants in force (the multi-query group limit). */
  maxMultiQuery: number;
}

export interface TerminologyBudget {
  /** The cap the variant builder is called with. */
  variantCap: number;
  /** Whether term:0 is searched. */
  termSearch: boolean;
  /** The multi-query variants kept, in preference order. */
  multiQuery: QueryVariant[];
  search_cut: 0 | 1;
  variant_cut: 0 | 1;
}

const MULTI_QUERY_ORDER: readonly QueryVariantKind[] = ['terminology', 'expanded', 'hyde'];

function multiQueryPosition(kind: QueryVariantKind): number {
  const index = MULTI_QUERY_ORDER.indexOf(kind);
  return index < 0 ? MULTI_QUERY_ORDER.length : index;
}

/**
 * D-31 items 1 to 4. term:0 takes one search unless the protected variants alone fill max_searches (then it is not searched and
 * the variants keep the full cap); the terminology variant stands first in the multi-query group and counts toward its limit; a
 * multi-query text equal to the terminology text is dropped and the terminology variant kept.
 */
export function terminologyBudget(input: TerminologyBudgetInput): TerminologyBudget {
  const searchCut = input.termSearch && input.protectedCount >= input.maxSearches;
  const termSearch = input.termSearch && !searchCut;
  const variantCap = termSearch ? input.maxSearches - 1 : input.maxSearches;
  const places = Math.max(0, Math.min(input.maxMultiQuery, variantCap - input.protectedCount));

  const ordered = input.multiQuery
    .map((variant, index) => ({ variant, index }))
    .sort((a, b) => multiQueryPosition(a.variant.kind) - multiQueryPosition(b.variant.kind) || a.index - b.index)
    .map((entry) => entry.variant);
  const seen = new Set<string>();
  const unique: QueryVariant[] = [];
  for (const variant of ordered) {
    const key = textKey(variant.text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    unique.push(variant);
  }
  const multiQuery = unique.slice(0, places);
  const offered = unique.some((variant) => variant.kind === 'terminology');
  const kept = multiQuery.some((variant) => variant.kind === 'terminology');
  return { variantCap, termSearch, multiQuery, search_cut: searchCut ? 1 : 0, variant_cut: offered && !kept ? 1 : 0 };
}
