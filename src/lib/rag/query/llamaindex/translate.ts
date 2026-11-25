import { QueryTranslationSchema } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps, type RagDeps } from '../../deps';
import { QueryLlmError } from '../llm';
import { checkVariant, DEFAULT_POST_CHECK_LIMITS, type PostCheckLimits, type PostCheckSkipReason } from '../post-checks';
import { LANGUAGE_NAMES, loadPrompt, renderTemplate } from '../prompts/render';
import type { Lang } from '../rewrite-gate';

export type TranslateSkipReason = PostCheckSkipReason | 'invalid_output' | 'unavailable' | 'aborted' | 'error';
/** Names the target and the reason only; never query or output text. */
export type TranslateSkip = { kind: 'translate'; target: Lang; reason: TranslateSkipReason };
export type TranslatedVariant = { kind: 'translated'; language: Lang; text: string };
export type NativeTranslateResult = { variants: TranslatedVariant[]; skipped: TranslateSkip[] };

export interface NativeTranslateInput {
  query: string;
  /** The query's own language; it is never a target. */
  language: Lang;
  /** From translationTargets (kb-languages.ts); duplicates are dropped and at most two are used. */
  targets: readonly Lang[];
  protectedTokens: readonly string[];
  signal: AbortSignal;
  /** QueryParams.max_translations; never above the D-08 cap of 2. */
  maxItems?: number;
  limits?: PostCheckLimits;
  deps?: Pick<RagDeps, 'queryLlm'>;
}

const PROMPT_ID = 'shared.translate';
/** D-08 hard cap on translated variants. */
export const MAX_TRANSLATIONS = 2;
const SYSTEM = 'You translate search queries for document retrieval. Return only the requested JSON object.';
const QUERY_TAG = /<\s*\/?\s*query\b[^>]*>/giu;

function escapeQueryTags(text: string): string {
  return text.replace(QUERY_TAG, (match) => match.replace(/</gu, '&lt;').replace(/>/gu, '&gt;'));
}

function pickTargets(language: Lang, targets: readonly Lang[], maxItems: number | undefined): Lang[] {
  const cap = Math.max(0, Math.min(MAX_TRANSLATIONS, Math.floor(maxItems ?? MAX_TRANSLATIONS)));
  const picked: Lang[] = [];
  for (const target of targets) {
    if (picked.length >= cap) break;
    if (target === language || picked.includes(target) || !(target in LANGUAGE_NAMES)) continue;
    picked.push(target);
  }
  return picked;
}

function failureReason(error: unknown, signal: AbortSignal): TranslateSkipReason {
  if (signal.aborted) return 'aborted';
  if (error instanceof QueryLlmError) return error.kind;
  return 'error';
}

/**
 * The native translate transform (D-23, D-24): one query-LLM call per target, all in parallel, with the shared translate
 * prompt (research A-6) and QueryTranslationSchema. Each output passes the D-15 post-checks; a translation that drops a
 * protected token, answers in another language or fails is skipped and recorded. Never more than two variants.
 */
export async function nativeTranslate(input: NativeTranslateInput): Promise<NativeTranslateResult> {
  const targets = pickTargets(input.language, input.targets, input.maxItems);
  if (targets.length === 0) return { variants: [], skipped: [] };

  const prompt = loadPrompt(PROMPT_ID);
  const llm = (input.deps ?? getRagDeps()).queryLlm();
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const tokens = input.protectedTokens.length > 0 ? escapeQueryTags(JSON.stringify(input.protectedTokens)) : 'none';
  const query = escapeQueryTags(input.query);

  const outcomes = await Promise.all(
    targets.map(async (target): Promise<TranslatedVariant | TranslateSkip> => {
      const skip = (reason: TranslateSkipReason): TranslateSkip => ({ kind: 'translate', target, reason });
      let output;
      try {
        output = await llm.generate({
          transform: 'translate',
          schema: QueryTranslationSchema,
          system: SYSTEM,
          prompt: renderTemplate(prompt, {
            target_language: LANGUAGE_NAMES[target],
            protected_tokens: tokens,
            target_code: target,
            query,
          }),
          input: input.query,
          targetLanguage: target,
          signal: input.signal,
        });
      } catch (error) {
        return skip(failureReason(error, input.signal));
      }
      if (output.target_language !== target) return skip('invalid_output');
      const checked = checkVariant(
        { kind: 'translate', text: output.text, input: input.query, protectedTokens: input.protectedTokens },
        limits,
      );
      if (!checked.ok) return skip(checked.skip.reason);
      return { kind: 'translated', language: target, text: checked.text };
    }),
  );

  const variants: TranslatedVariant[] = [];
  const skipped: TranslateSkip[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'translated') variants.push(outcome);
    else skipped.push(outcome);
  }
  return { variants, skipped };
}
