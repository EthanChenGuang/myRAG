import { z } from 'zod/v3';
import { SubQuestionsSchema } from '@/lib/rag-eval/contracts.generated';
import type { Lang } from '../rewrite-gate';
import type { CompletenessRecord, RequiredTerm } from '../completeness';
import {
  checkSubQuestions,
  checkSubQuestionsWithCompleteness,
  DEFAULT_POST_CHECK_LIMITS,
  type CompletenessCheck,
  type PostCheckLimits,
  type PostCheckSkip,
} from '../post-checks';
import { loadPrompt, renderPrompt } from '../prompts/render';
import subqPrompt from '../prompts/llamaindex.subq.v1.json';
import { callNative, NATIVE_SYSTEM_PROMPT, type NativeDeps, type NativeTransformSkip } from './call';

const PROMPT_ID = 'llamaindex.subq';
/** Upper bound on what the model may return before D-15 cuts the list to max_sub_questions. */
export const WIRE_MAX_QUESTIONS = 16;

/**
 * The SubQuestions contract (strict, questions only, so an answer field fails validation) with the
 * list bound widened: D-15 cuts surplus sub-questions instead of discarding the whole output.
 */
const SubQuestionsWireSchema = SubQuestionsSchema.extend({ questions: z.array(z.string()).max(WIRE_MAX_QUESTIONS) });

export type SubQuestionVariant = {
  text: string;
  language: Lang;
  kind: 'sub_question';
  legs: 'both';
  protectedOk: true;
  subQuestionIndex: number;
};
export type DecomposeInput = {
  query: string;
  language: Lang;
  protectedTokens: readonly string[];
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
  /** D-03/D-04: present only while RAG_QUERY_DECOMPOSE_COMPLETENESS is effectively on; absent keeps the D-15 checks as they were. */
  requiredTerms?: readonly RequiredTerm[];
};
export type DecomposeResult = {
  variants: SubQuestionVariant[];
  notCompound: boolean;
  skipped: Array<PostCheckSkip | NativeTransformSkip>;
  /** Counts and the action only (D-04); set only when the completeness check ran. */
  completeness?: CompletenessRecord;
};

export type FinishDecomposeInput = Pick<DecomposeInput, 'query' | 'language' | 'protectedTokens' | 'limits' | 'requiredTerms'>;

/** A completeness failure falls back to today's D-15 result, recorded as a decompose skip with reason error. */
function postCheck(input: FinishDecomposeInput, questions: readonly string[], limits: PostCheckLimits): CompletenessCheck {
  const sub = { questions, input: input.query, protectedTokens: input.protectedTokens };
  if (!input.requiredTerms) return checkSubQuestions(sub, limits);
  try {
    return checkSubQuestionsWithCompleteness(sub, limits, input.requiredTerms);
  } catch {
    console.warn('[Query Layer] decomposition completeness check failed; D-15 result kept');
    const checked = checkSubQuestions(sub, limits);
    return { ...checked, skipped: [...checked.skipped, { kind: 'decompose', reason: 'error' }] };
  }
}

/**
 * The post-check step after the decompose LLM call, shared by both frameworks (D-02): the output must match the
 * SubQuestions wire contract (else a skip with reason error, as a failed call), then D-15 cuts and checks the list; with
 * required terms the order is per-question checks, checkDecompositionCompleteness, cap, union check (D-04, P-15).
 */
export function finishDecompose(input: FinishDecomposeInput, output: unknown): DecomposeResult {
  const parsed = SubQuestionsWireSchema.safeParse(output);
  if (!parsed.success) return { variants: [], notCompound: false, skipped: [{ transform: 'decompose', reason: 'error' }] };
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const checked = postCheck(input, parsed.data.questions, limits);
  return {
    variants: checked.subQuestions.map((text, subQuestionIndex) => ({
      text: text.trim(),
      language: input.language,
      kind: 'sub_question',
      legs: 'both',
      protectedOk: true,
      subQuestionIndex,
    })),
    notCompound: checked.notCompound,
    skipped: checked.skipped,
    ...(checked.completeness ? { completeness: checked.completeness } : {}),
  };
}

/** LlamaIndex SubQuestionQueryEngine question generation without tools; it only splits, it never answers. */
export async function nativeDecompose(input: DecomposeInput): Promise<DecomposeResult> {
  const { query, language, protectedTokens, signal, deps } = input;
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const prompt = renderPrompt(
    loadPrompt(PROMPT_ID, { [PROMPT_ID]: subqPrompt }),
    { query_str: query },
    { language, maxItems: limits.maxSubQuestions, protectedTokens },
  );
  const call = await callNative(deps, {
    transform: 'decompose',
    schema: SubQuestionsWireSchema,
    system: NATIVE_SYSTEM_PROMPT,
    prompt,
    input: query,
    signal,
  });
  if (!call.ok) return { variants: [], notCompound: false, skipped: [call.skip] };
  return finishDecompose(input, call.value);
}
