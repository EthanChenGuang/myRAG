import { getLanguageSettings } from '../lang/settings';
import { getLanguagePack } from '../lang/registry';

export interface ScopeNotice {
  /** Written as the first text part of the answer. */
  notice: string;
  /** Appended to the system prompt so the model does not repeat the notice. */
  rule: string;
  language: string;
}

const FALLBACK_LANGUAGE = 'en';

/**
 * Phase 6.2 D-26, P-05: the localized scope notice and its prompt sentence, from the first of the answer language, the
 * primary language and English whose pack holds both texts; null when none does (the turn is answered as today).
 */
export function scopeGateNoticeFor(language: string | null | undefined): ScopeNotice | null {
  for (const code of [language, getLanguageSettings().primary, FALLBACK_LANGUAGE]) {
    if (typeof code !== 'string' || code.length === 0) continue;
    const texts = getLanguagePack(code)?.texts.query_layer;
    const notice = texts?.scope_gate_notice;
    const rule = texts?.scope_gate_prompt_rule;
    if (notice && rule) return { notice, rule, language: code };
  }
  return null;
}

/** D-26: retrieval was skipped because the scope gate labelled the question out_of_scope. */
export function isOutOfScopeResult(
  result: { skipReason?: string; scopeGate?: { label?: string } | null } | null | undefined,
): boolean {
  return result?.skipReason === 'out_of_scope' && result.scopeGate?.label === 'out_of_scope';
}
