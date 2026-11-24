import type { QueryVariant } from '../types';

export const MAX_QUERY_VARIANTS = 3;

export interface TranslatedQuery {
  text: string;
  language: string;
}

export function buildQueryVariants(
  _query: string,
  _language: string | null,
  _translated: readonly TranslatedQuery[] = [],
  _provided: readonly QueryVariant[] = [],
): QueryVariant[] {
  return [];
}
