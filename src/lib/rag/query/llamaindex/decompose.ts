import { z } from 'zod/v3';
import { SubQuestionsSchema, SubQuestionsWithFiltersSchema } from '@/lib/rag-eval/contracts.generated';
import type { RetrievalFilterInput } from '../../backend/types';
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
import { loadPrompt, renderPrompt, renderSubqFilterAddendum } from '../prompts/render';
import {
  narrowFilters,
  parseProposedFilter,
  SUB_QUESTION_FILTER_FIELDS,
  type NarrowVocabulary,
  type SubQuestionFilter,
} from '../subq-filters';
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

/** P-18: SubQuestionsWithFilters with the same widened list bound; sent only while RAG_QUERY_SUBQ_FILTERS is effective. */
const SubQuestionsWithFiltersWireSchema = SubQuestionsWithFiltersSchema.extend({
  questions: SubQuestionsWithFiltersSchema.shape.questions.element.array().max(WIRE_MAX_QUESTIONS),
});

/**
 * What the finisher reads from either output shape: plain strings (SubQuestions) or {text, filter} items. Each filter is
 * checked on its own afterwards (parseProposedFilter), so one invalid filter drops that filter, not the whole output.
 */
const LenientItemSchema = z.union([z.string(), z.object({ text: z.string(), filter: z.unknown() }).strict()]);
const LenientWireSchema = z.object({ questions: z.array(LenientItemSchema).max(WIRE_MAX_QUESTIONS) }).strict();

/** The SubQuestionFilterTrace contract (D-06); retried and retry_skipped_cap are set by the search stage (06.2-16). */
export type SubQuestionFilterTraceEntry = {
  index: number;
  status: 'applied' | 'dropped_invalid' | 'dropped_empty_intersection' | 'dropped_unknown_values' | 'stripped_switch_off';
  retried: boolean;
  retry_skipped_cap: boolean;
};
export type SubQuestionSpecOut = { text: string; filter: SubQuestionFilter | null };

/** D-06, D-07: present only while RAG_QUERY_SUBQ_FILTERS is effective; absent keeps the Phase 6 request and result. */
export type SubqFilterContext = {
  /** The request's own filters, the base every proposal can only narrow. */
  base: RetrievalFilterInput | undefined;
  /** The request tenant's own values; never another tenant's. */
  vocabulary: NarrowVocabulary;
  /** subq_filter_vocab_cap for the prompt addendum. */
  vocabCap: number;
};

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
  /** D-14: glossary source terms in the query (RAG_TRANSLATION_GLOSSARY effective); the kept sub-questions together must keep them. */
  glossaryProtected?: readonly string[];
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
  /** D-03/D-04: present only while RAG_QUERY_DECOMPOSE_COMPLETENESS is effectively on; absent keeps the D-15 checks as they were. */
  requiredTerms?: readonly RequiredTerm[];
  subqFilters?: SubqFilterContext;
};
export type DecomposeResult = {
  variants: SubQuestionVariant[];
  notCompound: boolean;
  skipped: Array<PostCheckSkip | NativeTransformSkip>;
  /** Counts and the action only (D-04); set only when the completeness check ran. */
  completeness?: CompletenessRecord;
  /** D-05: one spec per sub-question (texts equal the variant texts), the filter as narrowed; only with the switch on. */
  subQuestionSpecs?: SubQuestionSpecOut[];
  /** The narrowed retrieval filters per spec (null: none applied), for the per-variant search (06.2-16). */
  subQuestionFilters?: Array<RetrievalFilterInput | null>;
  /** One entry per spec with the switch on; with it off only when a returned filter was stripped. */
  filterTrace?: SubQuestionFilterTraceEntry[];
};

export type FinishDecomposeInput = Pick<
  DecomposeInput,
  'query' | 'language' | 'protectedTokens' | 'glossaryProtected' | 'limits' | 'requiredTerms' | 'subqFilters'
>;

/** The addendum the decomposer prompt ends with while the switch is effective (both frameworks, D-07). */
export function subqFilterAddendum(context: SubqFilterContext): string {
  return renderSubqFilterAddendum({
    fields: SUB_QUESTION_FILTER_FIELDS,
    scopes: context.vocabulary.scopes,
    docTypes: context.vocabulary.docTypes,
    languages: context.vocabulary.languages,
    cap: context.vocabCap,
  });
}

type ProposedSpec = { text: string; filter: unknown; carriesFilter: boolean };

function proposedSpecs(output: unknown): ProposedSpec[] | null {
  const parsed = LenientWireSchema.safeParse(output);
  if (!parsed.success) return null;
  return parsed.data.questions.map((item) =>
    typeof item === 'string'
      ? { text: item, filter: null, carriesFilter: false }
      : { text: item.text, filter: item.filter, carriesFilter: item.filter !== null && item.filter !== undefined },
  );
}

/** A completeness failure falls back to today's D-15 result, recorded as a decompose skip with reason error. */
function postCheck(input: FinishDecomposeInput, questions: readonly string[], limits: PostCheckLimits): CompletenessCheck {
  const sub = {
    questions,
    input: input.query,
    protectedTokens: input.protectedTokens,
    ...(input.glossaryProtected ? { glossaryProtected: input.glossaryProtected } : {}),
  };
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
  const failed: DecomposeResult = { variants: [], notCompound: false, skipped: [{ transform: 'decompose', reason: 'error' }] };
  const strict = input.subqFilters ? null : SubQuestionsWireSchema.safeParse(output);
  const specs = strict?.success ? strict.data.questions.map((text) => ({ text, filter: null, carriesFilter: false })) : proposedSpecs(output);
  if (!specs) return failed;
  // P-18: with the switch off a returned filter is stripped (and traced below); the texts follow the Phase 6 path.
  const stripped = !input.subqFilters && specs.some((spec) => spec.carriesFilter);
  if (input.subqFilters && specs.some((spec) => spec.text.trim() === '')) return failed;

  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const checked = postCheck(input, specs.map((spec) => spec.text), limits);
  const variants: SubQuestionVariant[] = checked.subQuestions.map((text, subQuestionIndex) => ({
    text: text.trim(),
    language: input.language,
    kind: 'sub_question',
    legs: 'both',
    protectedOk: true,
    subQuestionIndex,
  }));
  const result: DecomposeResult = {
    variants,
    notCompound: checked.notCompound,
    skipped: checked.skipped,
    ...(checked.completeness ? { completeness: checked.completeness } : {}),
  };
  if (stripped) {
    result.filterTrace = variants.map((_variant, index) => ({ index, status: 'stripped_switch_off', retried: false, retry_skipped_cap: false }));
    return result;
  }
  const context = input.subqFilters;
  if (!context) return result;

  // D-06: each kept sub-question takes the proposal of the spec with the same text (a repaired or added one has none).
  const used = new Set<number>();
  const subQuestionSpecs: SubQuestionSpecOut[] = [];
  const subQuestionFilters: Array<RetrievalFilterInput | null> = [];
  const filterTrace: SubQuestionFilterTraceEntry[] = [];
  variants.forEach((variant, index) => {
    const at = specs.findIndex((spec, i) => !used.has(i) && spec.text.trim() === variant.text);
    if (at >= 0) used.add(at);
    const parsed = parseProposedFilter(at >= 0 ? (specs[at]!.filter ?? null) : null);
    if (!parsed.ok) {
      subQuestionSpecs.push({ text: variant.text, filter: null });
      subQuestionFilters.push(null);
      filterTrace.push({ index, status: 'dropped_invalid', retried: false, retry_skipped_cap: false });
      return;
    }
    const narrowed = narrowFilters(context.base, parsed.filter, context.vocabulary);
    subQuestionSpecs.push({ text: variant.text, filter: narrowed.applied });
    subQuestionFilters.push(narrowed.applied ? (narrowed.filters ?? null) : null);
    filterTrace.push({ index, status: narrowed.status, retried: false, retry_skipped_cap: false });
  });
  return { ...result, subQuestionSpecs, subQuestionFilters, filterTrace };
}

/**
 * The structured schema of the native call: the JSON sent is exactly the strict contract (SubQuestions with the switch off,
 * SubQuestionsWithFilters with it on), while the parse keeps the raw output for the shared finisher, which owns the
 * per-filter checks and the switch-off strip, so both frameworks finish the same raw value.
 */
function capturingSchema(filtersOn: boolean): { schema: z.ZodType<unknown>; raw: () => unknown } {
  let captured = false;
  let raw: unknown;
  const normalize = (value: unknown): unknown => {
    if (!captured) {
      captured = true;
      raw = value;
    }
    const specs = proposedSpecs(value);
    if (!specs) return value;
    return filtersOn
      ? { questions: specs.map((spec) => ({ text: spec.text, filter: parseProposedFilter(spec.filter ?? null).ok ? (spec.filter ?? null) : null })) }
      : { questions: specs.map((spec) => spec.text) };
  };
  const strict = filtersOn ? SubQuestionsWithFiltersWireSchema : SubQuestionsWireSchema;
  return { schema: z.preprocess(normalize, strict), raw: () => raw };
}

/** LlamaIndex SubQuestionQueryEngine question generation without tools; it only splits, it never answers. */
export async function nativeDecompose(input: DecomposeInput): Promise<DecomposeResult> {
  const { query, language, protectedTokens, signal, deps } = input;
  const limits = input.limits ?? DEFAULT_POST_CHECK_LIMITS;
  const base = renderPrompt(
    loadPrompt(PROMPT_ID, { [PROMPT_ID]: subqPrompt }),
    { query_str: query },
    { language, maxItems: limits.maxSubQuestions, protectedTokens },
  );
  const prompt = input.subqFilters ? `${base}\n\n${subqFilterAddendum(input.subqFilters)}` : base;
  const wire = capturingSchema(input.subqFilters !== undefined);
  const call = await callNative(deps, {
    transform: 'decompose',
    schema: wire.schema,
    system: NATIVE_SYSTEM_PROMPT,
    prompt,
    input: query,
    signal,
  });
  if (!call.ok) return { variants: [], notCompound: false, skipped: [call.skip] };
  return finishDecompose(input, wire.raw() ?? call.value);
}
