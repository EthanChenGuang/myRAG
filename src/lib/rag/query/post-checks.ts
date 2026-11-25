export type CheckedKind = 'condense' | 'expand' | 'translate' | 'decompose' | 'hyde';
export type PostCheckSkipReason = 'protected_token_lost' | 'length' | 'empty' | 'cap';
export type PostCheckSkip = { kind: CheckedKind; reason: PostCheckSkipReason; index?: number; count?: number };
export type PostCheckLimits = { variantMaxChars: number; variantMaxRatio: number; maxSubQuestions: number };
export const DEFAULT_POST_CHECK_LIMITS: PostCheckLimits = { variantMaxChars: 500, variantMaxRatio: 4, maxSubQuestions: 4 };
export type VariantCheck = { ok: true; text: string } | { ok: false; skip: PostCheckSkip };
export type CondensedCheck = { text: string; passThrough: boolean; skip: PostCheckSkip | null };
export type SubQuestionsCheck = { subQuestions: string[]; notCompound: boolean; skipped: PostCheckSkip[] };

export function checkVariant(
  input: { kind: Exclude<CheckedKind, 'condense' | 'decompose'>; text: string; input: string; protectedTokens: readonly string[] },
  _limits: PostCheckLimits,
): VariantCheck {
  return { ok: true, text: input.text };
}

export function checkCondensed(
  input: { text: string; input: string; protectedTokens: readonly string[] },
  _limits: PostCheckLimits,
): CondensedCheck {
  return { text: input.text, passThrough: false, skip: null };
}

export function checkSubQuestions(
  input: { questions: readonly string[]; input: string; protectedTokens: readonly string[] },
  _limits: PostCheckLimits,
): SubQuestionsCheck {
  return { subQuestions: [...input.questions], notCompound: false, skipped: [] };
}
