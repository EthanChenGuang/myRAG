import { QueryTranslationSchema } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps, type RagDeps } from '../../deps';
import { enforceGlossary, requiredTranslations, type TenantGlossary } from '../glossary';
import { QueryLlmError } from '../llm';
import { checkVariant, DEFAULT_POST_CHECK_LIMITS, type PostCheckLimits, type PostCheckSkipReason } from '../post-checks';
import { LANGUAGE_NAMES, loadPrompt, renderGlossaryAddendum, renderTemplate } from '../prompts/render';
import type { Lang } from '../rewrite-gate';

export type TranslateSkipReason = PostCheckSkipReason | 'glossary_term_lost' | 'invalid_output' | 'unavailable' | 'aborted' | 'error';
/** Names the target and the reason only; never query or output text. */
export type TranslateSkip = { kind: 'translate'; target: Lang; reason: TranslateSkipReason };
export type TranslatedVariant = { kind: 'translated'; language: Lang; text: string };
/** `sourceLanguage` (D-17): the first source language a valid output reported; absent when none did. */
export type NativeTranslateResult = { variants: TranslatedVariant[]; skipped: TranslateSkip[]; sourceLanguage?: Lang };

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
  /** D-14: the request tenant's glossary while RAG_TRANSLATION_GLOSSARY is effective; absent or null changes nothing. */
  glossary?: TenantGlossary | null;
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

export type TranslateRequestInput = Omit<NativeTranslateInput, 'deps' | 'signal'>;
/** One translate call: the target and the rendered system and user text (the shared prompt, research A-6). */
export interface TranslateRequest {
  target: Lang;
  system: string;
  prompt: string;
}
/** A call's raw output, or the reason it failed (the same kinds for both frameworks). */
export type TranslateCallOutcome = { target: Lang; output: unknown } | { target: Lang; failure: TranslateSkipReason };

/** The calls a translate transform makes: one per picked target, at most two, with the shared prompt. */
export function translateRequests(input: TranslateRequestInput): TranslateRequest[] {
  const targets = pickTargets(input.language, input.targets, input.maxItems);
  if (targets.length === 0) return [];
  const prompt = loadPrompt(PROMPT_ID);
  const tokens = input.protectedTokens.length > 0 ? escapeQueryTags(JSON.stringify(input.protectedTokens)) : 'none';
  const query = escapeQueryTags(input.query);
  return targets.map((target) => {
    const base = renderTemplate(prompt, {
      target_language: LANGUAGE_NAMES[target],
      protected_tokens: tokens,
      target_code: target,
      query,
    });
    // D-14: the required pairs for this target only; none (or no glossary) leaves the Phase 6 prompt byte for byte.
    const addendum = renderGlossaryAddendum(requiredTranslations(input.query, input.language, target, input.glossary));
    return { target, system: SYSTEM, prompt: addendum ? `${base}\n\n${addendum}` : base };
  });
}

/**
 * The post-check step after the translate calls, shared by both frameworks (D-02): each output must parse as
 * QueryTranslation for its target, keep the glossary's required terms (D-14) and pass the D-15 checks; anything else is a
 * recorded skip. Order follows the calls.
 */
export function finishTranslate(input: TranslateRequestInput, outcomes: readonly TranslateCallOutcome[]): NativeTranslateResult {
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const variants: TranslatedVariant[] = [];
  const skipped: TranslateSkip[] = [];
  let sourceLanguage: Lang | null = null;
  for (const outcome of outcomes) {
    const { target } = outcome;
    const skip = (reason: TranslateSkipReason) => skipped.push({ kind: 'translate', target, reason });
    if ('failure' in outcome) {
      skip(outcome.failure);
      continue;
    }
    const parsed = QueryTranslationSchema.safeParse(outcome.output);
    if (!parsed.success || parsed.data.target_language !== target) {
      skip('invalid_output');
      continue;
    }
    sourceLanguage ??= parsed.data.source_language ?? null;
    // D-14: a missing required term is corrected once from its untranslated source surface, else the translation is dropped.
    const required = requiredTranslations(input.query, input.language, target, input.glossary);
    const enforced = required.length > 0 ? enforceGlossary(parsed.data.text, required) : { status: 'ok' as const, text: parsed.data.text };
    if (enforced.status === 'lost') {
      skip('glossary_term_lost');
      continue;
    }
    const checked = checkVariant({ kind: 'translate', text: enforced.text, input: input.query, protectedTokens: input.protectedTokens }, limits);
    if (!checked.ok) skip(checked.skip.reason);
    else variants.push({ kind: 'translated', language: target, text: checked.text });
  }
  return { variants, skipped, ...(sourceLanguage ? { sourceLanguage } : {}) };
}

/**
 * The native translate transform (D-23, D-24): one query-LLM call per target, all in parallel, with the shared translate
 * prompt (research A-6) and QueryTranslationSchema. Each output passes the D-15 post-checks; a translation that drops a
 * protected token, answers in another language or fails is skipped and recorded. Never more than two variants.
 */
export async function nativeTranslate(input: NativeTranslateInput): Promise<NativeTranslateResult> {
  const requests = translateRequests(input);
  if (requests.length === 0) return { variants: [], skipped: [] };

  const llm = (input.deps ?? getRagDeps()).queryLlm();
  const outcomes = await Promise.all(
    requests.map(async ({ target, system, prompt }): Promise<TranslateCallOutcome> => {
      try {
        const output = await llm.generate({
          transform: 'translate',
          schema: QueryTranslationSchema,
          system,
          prompt,
          input: input.query,
          targetLanguage: target,
          signal: input.signal,
        });
        return { target, output };
      } catch (error) {
        return { target, failure: failureReason(error, input.signal) };
      }
    }),
  );
  return finishTranslate(input, outcomes);
}
