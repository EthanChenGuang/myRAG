import { getLanguagePack, type LanguagePack } from './registry';
import { fallbackLanguages } from './texts';

export type NumberFormat = LanguagePack['number_format'];

/** The pack for `language`, falling back to RAG_PRIMARY_LANGUAGE and then English, as fixedText does (D-09). */
function packFor(language: string): LanguagePack {
  for (const code of fallbackLanguages(language)) {
    const pack = code === null ? undefined : getLanguagePack(code);
    if (pack) return pack;
  }
  throw new Error('[Language Registry] no pack for the language or its fallbacks');
}

/** Phase 5.2.1 D-74: how numbers are written in `language` (grouping, decimal marks, full-width digits, magnitude words). */
export function numberFormatFor(language: string): NumberFormat {
  return packFor(language).number_format;
}

/** Phase 5.2.1 D-70: the computation-intent function words of `language`, case-folded and deduplicated, in registry order. */
export function calcIntentTermsFor(language: string): string[] {
  return [...new Set(packFor(language).calc_intent_terms.map((term) => term.toLowerCase()))];
}
