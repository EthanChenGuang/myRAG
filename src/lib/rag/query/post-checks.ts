import { checkDecompositionCompleteness, type CompletenessRecord, type RequiredTerm } from './completeness';
import { keepsProtectedTokens } from './protected';

export type CheckedKind = 'condense' | 'expand' | 'translate' | 'decompose' | 'hyde';
export type VariantKind = Exclude<CheckedKind, 'condense' | 'decompose'>;
/** `error` only for a completeness check that threw (the D-15 result is then used unchanged). */
export type PostCheckSkipReason = 'protected_token_lost' | 'length' | 'empty' | 'cap' | 'error';

/** A skip record names the transform and the reason only; it never carries query text. */
export type PostCheckSkip = {
  kind: CheckedKind;
  reason: PostCheckSkipReason;
  index?: number;
  count?: number;
};

/** QueryParams values: variant_max_chars, variant_max_ratio, max_sub_questions. */
export type PostCheckLimits = {
  variantMaxChars: number;
  variantMaxRatio: number;
  maxSubQuestions: number;
};

export const DEFAULT_POST_CHECK_LIMITS: Readonly<PostCheckLimits> = Object.freeze({
  variantMaxChars: 500,
  variantMaxRatio: 4,
  maxSubQuestions: 4,
});

export type VariantCheck = { ok: true; text: string } | { ok: false; skip: PostCheckSkip };
export type CondensedCheck = { text: string; passThrough: boolean; skip: PostCheckSkip | null };
export type SubQuestionsCheck = { subQuestions: string[]; notCompound: boolean; skipped: PostCheckSkip[] };

/**
 * D-14: glossaryProtected holds the glossary source terms found in the input (RAG_TRANSLATION_GLOSSARY effective). A rewrite must
 * keep each verbatim (sub-questions: together), like a protected token; they are a separate list, never the gate's tokens.
 */
export type GlossaryProtection = { glossaryProtected?: readonly string[] };
export type VariantInput = { kind: VariantKind; text: string; input: string; protectedTokens: readonly string[] } & GlossaryProtection;
export type CondensedInput = { text: string; input: string; protectedTokens: readonly string[] } & GlossaryProtection;
export type SubQuestionsInput = { questions: readonly string[]; input: string; protectedTokens: readonly string[] } & GlossaryProtection;

function charCount(text: string): number {
  return Array.from(text).length;
}

function normalizeForCompare(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function failure(
  kind: CheckedKind,
  text: string,
  input: string,
  protectedTokens: readonly string[],
  limits: PostCheckLimits,
  glossaryProtected: readonly string[] = [],
): PostCheckSkipReason | null {
  if (text.trim().length === 0) return 'empty';
  const length = charCount(text);
  if (length > limits.variantMaxChars) return 'length';
  // A-10: a HyDE passage is a hypothetical answer, longer than the query by design, and it drives
  // only the dense leg (never rerank or refusal), so it skips the ratio cap and the protected-token check.
  if (kind === 'hyde') return null;
  if (length > limits.variantMaxRatio * charCount(input)) return 'length';
  if (!keepsProtectedTokens(text, protectedTokens)) return 'protected_token_lost';
  if (!keepsProtectedTokens(text, glossaryProtected)) return 'protected_token_lost';
  return null;
}

export function checkVariant(variant: VariantInput, limits: PostCheckLimits): VariantCheck {
  const reason = failure(variant.kind, variant.text, variant.input, variant.protectedTokens, limits, variant.glossaryProtected);
  if (reason) return { ok: false, skip: { kind: variant.kind, reason } };
  return { ok: true, text: variant.text };
}

/** Pass-through keeps the original text; a failed check falls back to it with a skip record. */
export function checkCondensed(condensed: CondensedInput, limits: PostCheckLimits): CondensedCheck {
  if (normalizeForCompare(condensed.text) === normalizeForCompare(condensed.input)) {
    return { text: condensed.input, passThrough: true, skip: null };
  }
  const reason = failure('condense', condensed.text, condensed.input, condensed.protectedTokens, limits, condensed.glossaryProtected);
  if (reason) return { text: condensed.input, passThrough: false, skip: { kind: 'condense', reason } };
  return { text: condensed.text, passThrough: false, skip: null };
}

type PerQuestion = { early: SubQuestionsCheck } | { kept: string[]; skipped: PostCheckSkip[] };

function perQuestionChecks(sub: SubQuestionsInput, limits: PostCheckLimits): PerQuestion {
  const { input, protectedTokens } = sub;
  const questions = sub.questions.filter((q) => q.trim().length > 0);
  if (questions.length === 0) return { early: { subQuestions: [], notCompound: true, skipped: [] } };
  if (questions.length === 1 && normalizeForCompare(questions[0]) === normalizeForCompare(input)) {
    return { early: { subQuestions: [], notCompound: true, skipped: [] } };
  }

  const skipped: PostCheckSkip[] = [];
  const kept: string[] = [];
  questions.forEach((question, index) => {
    const reason = failure('decompose', question, input, [], limits);
    if (reason) {
      skipped.push({ kind: 'decompose', reason, index });
      return;
    }
    if (protectedTokens.length > 0 && !protectedTokens.some((token) => keepsProtectedTokens(question, [token]))) {
      skipped.push({ kind: 'decompose', reason: 'protected_token_lost', index });
      return;
    }
    kept.push(question);
  });
  return { kept, skipped };
}

function capAndUnion(
  kept: string[],
  skipped: PostCheckSkip[],
  protectedTokens: readonly string[],
  limits: PostCheckLimits,
  glossaryProtected: readonly string[] = [],
): SubQuestionsCheck {
  if (kept.length > limits.maxSubQuestions) {
    skipped.push({ kind: 'decompose', reason: 'cap', count: kept.length - limits.maxSubQuestions });
    kept.length = limits.maxSubQuestions;
  }

  if (kept.length > 0 && !keepsProtectedTokens(kept.join('\n'), [...protectedTokens, ...glossaryProtected])) {
    return { subQuestions: [], notCompound: false, skipped: [{ kind: 'decompose', reason: 'protected_token_lost' }] };
  }

  return { subQuestions: kept, notCompound: false, skipped };
}

/**
 * Each sub-question must keep at least one protected token and the kept list together must keep
 * all of them; a comparison splits its codes across sub-questions, so per-question "all tokens"
 * would reject every comparison.
 */
export function checkSubQuestions(sub: SubQuestionsInput, limits: PostCheckLimits): SubQuestionsCheck {
  const checked = perQuestionChecks(sub, limits);
  if ('early' in checked) return checked.early;
  return capAndUnion(checked.kept, checked.skipped, sub.protectedTokens, limits, sub.glossaryProtected);
}

export type CompletenessCheck = SubQuestionsCheck & { completeness?: CompletenessRecord };

/**
 * D-04 with RAG_QUERY_DECOMPOSE_COMPLETENESS on (research F-1): per-question checks, then the completeness repair, then the
 * cap, then the union protected-token check, so a lost token is repaired before the union check could discard the list.
 * No completeness record when nothing was decomposed (no sub-question survived the per-question checks).
 */
export function checkSubQuestionsWithCompleteness(
  sub: SubQuestionsInput,
  limits: PostCheckLimits,
  required: readonly RequiredTerm[],
): CompletenessCheck {
  const checked = perQuestionChecks(sub, limits);
  if ('early' in checked) return checked.early;
  if (checked.kept.length === 0) return capAndUnion(checked.kept, checked.skipped, sub.protectedTokens, limits, sub.glossaryProtected);
  const repaired = checkDecompositionCompleteness({
    original: sub.input,
    subQuestions: checked.kept,
    required,
    maxSubQuestions: limits.maxSubQuestions,
  });
  if (repaired.completeness.action === 'discarded') {
    return { subQuestions: [], notCompound: false, skipped: checked.skipped, completeness: repaired.completeness };
  }
  return { ...capAndUnion(repaired.subQuestions, checked.skipped, sub.protectedTokens, limits, sub.glossaryProtected), completeness: repaired.completeness };
}
