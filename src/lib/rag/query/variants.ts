import type { QueryVariant } from '../types';

export const MAX_QUERY_VARIANTS = 3;

export interface TranslatedQuery {
  text: string;
  language: string;
}

function textKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

/**
 * The searched variants: the original first, then variants supplied by the caller (the Phase 6 seam), then translate-stage output.
 * Duplicates by text are dropped and the list is cut to MAX_QUERY_VARIANTS. A supplied variant never stands in for the original.
 */
export function buildQueryVariants(
  query: string,
  language: string | null,
  translated: readonly TranslatedQuery[] = [],
  provided: readonly QueryVariant[] = [],
): QueryVariant[] {
  const variants: QueryVariant[] = [{ text: query, language, kind: 'original' }];
  const seen = new Set([textKey(query)]);
  const extras: QueryVariant[] = [
    ...provided.filter((variant) => variant.kind !== 'original'),
    ...translated.map((item): QueryVariant => ({ text: item.text, language: item.language, kind: 'translated' })),
  ];
  for (const variant of extras) {
    if (variants.length >= MAX_QUERY_VARIANTS) break;
    const key = textKey(variant.text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    variants.push({ ...variant, text: variant.text.trim() });
  }
  return variants;
}
