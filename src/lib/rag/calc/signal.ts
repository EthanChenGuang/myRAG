import { calcIntentTermsFor } from '../lang/registry-fields';
import { scanQuantities } from '../query/protected';

export type CalcOfferReason = 'question_quantity' | 'intent_with_context_quantity';

export interface CalcOfferInput {
  question: string;
  /** The texts of this request's context blocks. */
  blockTexts: readonly string[];
  /** D-09 answer language; null falls back to RAG_PRIMARY_LANGUAGE and English through the registry. */
  language: string | null;
}

export interface CalcOfferDecision {
  offer: boolean;
  reason: CalcOfferReason | null;
}

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const matcherCache = new Map<string, (folded: string) => boolean>();

function intentMatcher(language: string): (folded: string) => boolean {
  const cached = matcherCache.get(language);
  if (cached) return cached;
  const substrings: string[] = [];
  const words: string[] = [];
  for (const term of calcIntentTermsFor(language)) {
    const folded = term.normalize('NFKC').toLowerCase();
    if (UNSPACED_SCRIPT.test(folded)) substrings.push(folded);
    else words.push(escapeRegExp(folded).replace(/\s+/g, '\\s+'));
  }
  const wordRegex = words.length > 0 ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'u') : null;
  const matcher = (folded: string) => substrings.some((term) => folded.includes(term)) || (wordRegex?.test(folded) ?? false);
  matcherCache.set(language, matcher);
  return matcher;
}

function hasIntentTerm(question: string, language: string | null): boolean {
  return intentMatcher(language ?? '')(question.normalize('NFKC').toLowerCase());
}

function hasQuantity(text: string): boolean {
  return scanQuantities(text).length > 0;
}

/** D-70, before retrieval: true whenever shouldOfferCalcTool can be true for this question (so a labeler can be requested). */
export function mayOfferCalc(question: string, language: string | null): boolean {
  if (typeof question !== 'string' || question.length === 0) return false;
  return hasQuantity(question) || hasIntentTerm(question, language);
}

/**
 * D-70, after retrieval: offer the calculation when the question carries a number, amount, percentage or date, or when it
 * carries a registry computation-intent term and a context block carries a quantity.
 */
export function shouldOfferCalcTool(input: CalcOfferInput): CalcOfferDecision {
  const { question, blockTexts, language } = input;
  if (typeof question !== 'string' || question.length === 0) return { offer: false, reason: null };
  if (hasQuantity(question)) return { offer: true, reason: 'question_quantity' };
  if (hasIntentTerm(question, language) && blockTexts.some((text) => typeof text === 'string' && hasQuantity(text))) {
    return { offer: true, reason: 'intent_with_context_quantity' };
  }
  return { offer: false, reason: null };
}
