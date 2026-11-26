import type { QueryVariant } from '../types';

export interface TerminologyBudgetInput {
  protectedCount: number;
  multiQuery: readonly QueryVariant[];
  termSearch: boolean;
  maxSearches: number;
  maxMultiQuery: number;
}

export interface TerminologyBudget {
  variantCap: number;
  termSearch: boolean;
  multiQuery: QueryVariant[];
  search_cut: 0 | 1;
  variant_cut: 0 | 1;
}

export function terminologyBudget(input: TerminologyBudgetInput): TerminologyBudget {
  return { variantCap: input.maxSearches, termSearch: input.termSearch, multiQuery: [...input.multiQuery], search_cut: 0, variant_cut: 0 };
}
