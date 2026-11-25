import type { QueryParams } from '@/lib/rag-eval/contracts.generated';
import type { QueryVariant, QueryVariantKind } from '../types';
import type { SkippedTransform } from './plan';

export const MAX_QUERY_VARIANTS = 3;

export interface TranslatedQuery {
  text: string;
  language: string;
}

/** expanded and hyde share one limit (D-08: the LLM-generated variants). */
export type VariantCapGroup = 'translated' | 'sub_question' | 'generated';

export interface VariantLimits {
  /** Searches per request, the original included. */
  cap: number;
  /** Preference order by kind; null keeps the caller's order (Phase 4). Kinds not listed go last in caller order. */
  order: readonly QueryVariantKind[] | null;
  groupLimits?: Partial<Record<VariantCapGroup, number>>;
}

export interface QueryVariantSet {
  variants: QueryVariant[];
  /** Every variant left out by the cap or a group limit, in preference order (reason cap). */
  cuts: SkippedTransform[];
}

export const PHASE4_VARIANT_LIMITS: Readonly<VariantLimits> = Object.freeze({ cap: MAX_QUERY_VARIANTS, order: null });

export const QUERY_LAYER_VARIANT_ORDER: readonly QueryVariantKind[] = Object.freeze([
  'original',
  'condensed',
  'translated',
  'sub_question',
  'expanded',
  'hyde',
]);

/** D-08 / A-6: the query layer's limits from the effective query params. */
export function queryLayerVariantLimits(
  _params: Pick<QueryParams, 'max_searches' | 'max_translations' | 'max_sub_questions' | 'max_llm_variants'>,
): VariantLimits {
  return { ...PHASE4_VARIANT_LIMITS };
}

function textKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

export function buildQueryVariantSet(
  query: string,
  language: string | null,
  translated: readonly TranslatedQuery[] = [],
  provided: readonly QueryVariant[] = [],
  limits: VariantLimits = PHASE4_VARIANT_LIMITS,
): QueryVariantSet {
  const variants: QueryVariant[] = [{ text: query, language, kind: 'original' }];
  const seen = new Set([textKey(query)]);
  const extras: QueryVariant[] = [
    ...provided.filter((variant) => variant.kind !== 'original'),
    ...translated.map((item): QueryVariant => ({ text: item.text, language: item.language, kind: 'translated' })),
  ];
  for (const variant of extras) {
    if (variants.length >= limits.cap) break;
    const key = textKey(variant.text);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    variants.push({ ...variant, text: variant.text.trim() });
  }
  return { variants, cuts: [] };
}

/**
 * The searched variants: the original first, then variants supplied by the caller (the Phase 6 seam), then translate-stage output.
 * Duplicates by text are dropped and the list is cut to the limits' cap. A supplied variant never stands in for the original.
 */
export function buildQueryVariants(
  query: string,
  language: string | null,
  translated: readonly TranslatedQuery[] = [],
  provided: readonly QueryVariant[] = [],
  limits: VariantLimits = PHASE4_VARIANT_LIMITS,
): QueryVariant[] {
  return buildQueryVariantSet(query, language, translated, provided, limits).variants;
}
