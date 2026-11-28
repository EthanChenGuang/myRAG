import { keepsProtectedTokens } from './protected';

export type CheckedKind = 'condense' | 'expand' | 'translate' | 'decompose' | 'hyde';
export type VariantKind = Exclude<CheckedKind, 'condense' | 'decompose'>;
export type PostCheckSkipReason = 'protected_token_lost' | 'length' | 'empty' | 'cap';

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

export type VariantInput = { kind: VariantKind; text: string; input: string; protectedTokens: readonly string[] };
export type CondensedInput = { text: string; input: string; protectedTokens: readonly string[] };
export type SubQuestionsInput = { questions: readonly string[]; input: string; protectedTokens: readonly string[] };

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
): PostCheckSkipReason | null {
  if (text.trim().length === 0) return 'empty';
  const length = charCount(text);
  if (length > limits.variantMaxChars) return 'length';
  // A-10: a HyDE passage is a hypothetical answer, longer than the query by design, and it drives
  // only the dense leg (never rerank or refusal), so it skips the ratio cap and the protected-token check.
  if (kind === 'hyde') return null;
  if (length > limits.variantMaxRatio * charCount(input)) return 'length';
  if (!keepsProtectedTokens(text, protectedTokens)) return 'protected_token_lost';
  return null;
}

export function checkVariant(variant: VariantInput, limits: PostCheckLimits): VariantCheck {
  const reason = failure(variant.kind, variant.text, variant.input, variant.protectedTokens, limits);
  if (reason) return { ok: false, skip: { kind: variant.kind, reason } };
  return { ok: true, text: variant.text };
}

/** Pass-through keeps the original text; a failed check falls back to it with a skip record. */
export function checkCondensed(condensed: CondensedInput, limits: PostCheckLimits): CondensedCheck {
  if (normalizeForCompare(condensed.text) === normalizeForCompare(condensed.input)) {
    return { text: condensed.input, passThrough: true, skip: null };
  }
  const reason = failure('condense', condensed.text, condensed.input, condensed.protectedTokens, limits);
  if (reason) return { text: condensed.input, passThrough: false, skip: { kind: 'condense', reason } };
  return { text: condensed.text, passThrough: false, skip: null };
}

/**
 * Each sub-question must keep at least one protected token and the kept list together must keep
 * all of them; a comparison splits its codes across sub-questions, so per-question "all tokens"
 * would reject every comparison.
 */
export function checkSubQuestions(sub: SubQuestionsInput, limits: PostCheckLimits): SubQuestionsCheck {
  const { input, protectedTokens } = sub;
  const questions = sub.questions.filter((q) => q.trim().length > 0);
  if (questions.length === 0) return { subQuestions: [], notCompound: true, skipped: [] };
  if (questions.length === 1 && normalizeForCompare(questions[0]) === normalizeForCompare(input)) {
    return { subQuestions: [], notCompound: true, skipped: [] };
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

  if (kept.length > limits.maxSubQuestions) {
    skipped.push({ kind: 'decompose', reason: 'cap', count: kept.length - limits.maxSubQuestions });
    kept.length = limits.maxSubQuestions;
  }

  if (kept.length > 0 && !keepsProtectedTokens(kept.join('\n'), protectedTokens)) {
    return { subQuestions: [], notCompound: false, skipped: [{ kind: 'decompose', reason: 'protected_token_lost' }] };
  }

  return { subQuestions: kept, notCompound: false, skipped };
}
