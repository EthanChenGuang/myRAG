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
  /** D-31: the terminology variant was offered and left out by the cap or the multi-query limit (never a plan cut). */
  terminologyCut: boolean;
}

export const PHASE4_VARIANT_LIMITS: Readonly<VariantLimits> = Object.freeze({ cap: MAX_QUERY_VARIANTS, order: null });

export const QUERY_LAYER_VARIANT_ORDER: readonly QueryVariantKind[] = Object.freeze([
  'original',
  'condensed',
  'translated',
  'sub_question',
  // D-31: the deterministic terminology variant stands first in the multi-query group.
  'terminology',
  'expanded',
  'hyde',
]);

/** D-08 / A-6: the query layer's limits from the effective query params. */
export function queryLayerVariantLimits(
  params: Pick<QueryParams, 'max_searches' | 'max_translations' | 'max_sub_questions' | 'max_llm_variants'>,
): VariantLimits {
  return {
    cap: params.max_searches,
    order: QUERY_LAYER_VARIANT_ORDER,
    groupLimits: {
      translated: params.max_translations,
      sub_question: params.max_sub_questions,
      generated: params.max_llm_variants,
    },
  };
}

const CUT_TRANSFORM: Record<Exclude<QueryVariantKind, 'original' | 'terminology'>, SkippedTransform['transform']> = {
  condensed: 'condense_history',
  translated: 'translate',
  sub_question: 'decompose',
  expanded: 'expand',
  hyde: 'hyde',
};

function capGroup(kind: QueryVariantKind): VariantCapGroup | null {
  if (kind === 'translated') return 'translated';
  if (kind === 'sub_question') return 'sub_question';
  if (kind === 'expanded' || kind === 'hyde' || kind === 'terminology') return 'generated';
  return null;
}

/** Stable: kinds in the preference order first, unlisted kinds after them, each in caller order. */
function inPreferenceOrder(variants: QueryVariant[], order: readonly QueryVariantKind[] | null): QueryVariant[] {
  if (!order) return variants;
  const position = (kind: QueryVariantKind) => {
    const index = order.indexOf(kind);
    return index < 0 ? order.length : index;
  };
  return variants
    .map((variant, index) => ({ variant, index }))
    .sort((a, b) => position(a.variant.kind) - position(b.variant.kind) || a.index - b.index)
    .map((entry) => entry.variant);
}

export function textKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim();
}

export function buildQueryVariantSet(
  query: string,
  language: string | null,
  translated: readonly TranslatedQuery[] = [],
  provided: readonly QueryVariant[] = [],
  limits: VariantLimits = PHASE4_VARIANT_LIMITS,
  terminology: QueryVariant | null = null,
): QueryVariantSet {
  const variants: QueryVariant[] = [{ text: query, language, kind: 'original' }];
  const seen = new Set([textKey(query)]);
  // Only the terminology stage makes a terminology variant (D-18); without the layer it goes after the translations (D-31).
  const extras: QueryVariant[] = [
    ...provided.filter((variant) => variant.kind !== 'original' && variant.kind !== 'terminology'),
    ...translated.map((item): QueryVariant => ({ text: item.text, language: item.language, kind: 'translated' })),
    ...(terminology && terminology.kind === 'terminology' ? [terminology] : []),
  ];
  let terminologyCut = false;
  const cuts: SkippedTransform[] = [];
  const used: Partial<Record<VariantCapGroup, number>> = {};
  for (const variant of inPreferenceOrder(extras, limits.order)) {
    const key = textKey(variant.text);
    if (key === '' || seen.has(key)) continue;
    const group = capGroup(variant.kind);
    const groupLimit = group ? limits.groupLimits?.[group] : undefined;
    if (variants.length >= limits.cap || (group && groupLimit !== undefined && (used[group] ?? 0) >= groupLimit)) {
      if (variant.kind === 'terminology') terminologyCut = true;
      else if (variant.kind !== 'original') cuts.push({ transform: CUT_TRANSFORM[variant.kind], reason: 'cap' });
      continue;
    }
    seen.add(key);
    if (group) used[group] = (used[group] ?? 0) + 1;
    variants.push({ ...variant, text: variant.text.trim() });
  }
  return { variants, cuts, terminologyCut };
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
  terminology: QueryVariant | null = null,
): QueryVariant[] {
  return buildQueryVariantSet(query, language, translated, provided, limits, terminology).variants;
}

/** The texts the embed stage sends, index-aligned with the variants (D-06: one batch). */
export function variantDenseTexts(variants: readonly QueryVariant[]): string[] {
  return variants.map((variant) => variant.denseText ?? variant.text);
}
