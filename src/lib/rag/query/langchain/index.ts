import { createHistoryAwareRetriever } from '@langchain/classic/chains/history_aware_retriever';
import { MultiQueryRetriever } from '@langchain/classic/retrievers/multi_query';
import type { BaseLanguageModelInput, BaseLanguageModelInterface } from '@langchain/core/language_models/base';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda } from '@langchain/core/runnables';
import { CondensedQuerySchema, QueryVariantsSchema } from '@/lib/rag-eval/contracts.generated';
import { loadPrompt, renderPrompt } from '../prompts/render';
import contextualizePrompt from '../prompts/langchain.contextualize.v1.json';
import decomposePrompt from '../prompts/langchain.decompose.v1.json';
import hydePrompt from '../prompts/langchain.hyde.v1.json';
import multiQueryPrompt from '../prompts/langchain.multi-query.v1.json';
import type {
  CondenseInput,
  CondenseResult,
  DecomposeResult,
  ExpandResult,
  HydeResult,
  QueryTransformer,
  QueryTransformFinishers,
  TransformDecomposeInput,
  TransformExpandInput,
  TransformHydeInput,
  TransformTranslateInput,
  TranslateCallOutcome,
  TranslateResult,
} from '../transformer';
import { CaptureRetriever } from './capture';
import { invokeConfig, RAW_STRUCTURED_SCHEMAS, structured, structuredRaw, type ChatModelFactory } from './chat-model';
import { LangChainAdapterError, raceAbort, toAdapterError, type LangChainTransform } from './errors';

export { CaptureRetriever } from './capture';
export { createChatModel, OPENROUTER_BASE_URL, structured, type ChatModelFactory, type ChatModelOptions } from './chat-model';
export { LangChainAdapterError } from './errors';

const CONTEXTUALIZE_ID = 'langchain.contextualize';
const MULTI_QUERY_ID = 'langchain.multi-query';
const HYDE_ID = 'langchain.hyde';
const DECOMPOSE_ID = 'langchain.decompose';

/** SubQuestions without the list bound: the shared finisher checks the wire bound and cuts to max_sub_questions (D-15). */
const SUB_QUESTIONS_WIRE_JSON: Record<string, unknown> = (() => {
  const schema = structuredClone(RAW_STRUCTURED_SCHEMAS.SubQuestions) as { properties: { questions: Record<string, unknown> } };
  delete schema.properties.questions.maxItems;
  return schema;
})();

export interface LangChainTransformerDeps {
  /** The shared post-check step (transformer.ts QUERY_TRANSFORM_FINISHERS), so results have exactly the native shapes. */
  finish: QueryTransformFinishers;
}

export interface CreateLangChainTransformerOptions {
  /** transformer.ts passes (transform) => createChatModel({ model, apiKey }, transform); tests pass the fake. */
  chatModelFactory: (transform: LangChainTransform) => ReturnType<ChatModelFactory>;
  deps: LangChainTransformerDeps;
}

type SkipOnError = { transform: 'expand' | 'hyde'; reason: 'error' };

/**
 * The chat model as a runnable that is built on first use and invoked with the request signal and no callbacks. Classic
 * chains drop the signal on the way to the model (LLMChain passes only llmKwargs), so it is bound here.
 */
function boundModel(options: CreateLangChainTransformerOptions, transform: LangChainTransform, signal: AbortSignal) {
  return RunnableLambda.from(async (input: BaseLanguageModelInput) => {
    const model = options.chatModelFactory(transform);
    return model.invoke(input, invokeConfig(signal));
  });
}

/** An abort propagates so the stage runner records the timeout; any other failure is a skip, as on the native path. */
function skipOrThrow(error: unknown, signal: AbortSignal, transform: 'expand' | 'hyde'): SkipOnError {
  const adapterError = toAdapterError(error, signal, transform);
  if (adapterError.kind === 'aborted') throw adapterError;
  return { transform, reason: 'error' };
}

/**
 * QRY-08 (D-17): the LangChain query transformer. condense runs createHistoryAwareRetriever with the vendored
 * contextualize prompt and expand runs MultiQueryRetriever.fromLLM, both over a CaptureRetriever that only records the
 * query text; hyde is a native port of LangChain's websearch HyDE template; decompose uses LangChain's decomposition
 * prompt with structured SubQuestions; translate uses the shared translate prompt. No call carries a scope, tenant key or
 * filter (D-18): the inputs are query text, history, language and protected tokens only.
 */
export function createLangChainTransformer(options: CreateLangChainTransformerOptions): QueryTransformer {
  const { finish } = options.deps;

  async function condense(input: CondenseInput): Promise<CondenseResult> {
    const { query, history, language, protectedTokens, signal } = input;
    const capture = new CaptureRetriever();
    const system = renderPrompt(
      loadPrompt(CONTEXTUALIZE_ID, { [CONTEXTUALIZE_ID]: contextualizePrompt }),
      {},
      { language, maxItems: 1, protectedTokens, history },
    );
    // The rendered text is a literal message, so braces in history or tokens are never read as template variables.
    const rephrasePrompt = ChatPromptTemplate.fromMessages([new SystemMessage(system), ['human', '{input}']]);
    const chain = await createHistoryAwareRetriever({ llm: boundModel(options, 'condense', signal), retriever: capture, rephrasePrompt });
    const chatHistory = history.map((turn) => (turn.role === 'user' ? new HumanMessage(turn.content) : new AIMessage(turn.content)));
    await raceAbort(() => chain.invoke({ input: query, chat_history: chatHistory }, invokeConfig(signal)), signal, 'condense');

    const captured = (capture.queries[0] ?? '').trim();
    const output = CondensedQuerySchema.safeParse(
      history.length === 0 ? { standalone: query, unchanged: true } : { standalone: captured, unchanged: false },
    );
    if (!output.success || output.data.standalone.trim() === '') throw new LangChainAdapterError('invalid_output', 'condense');
    return finish.condense(input, output.data);
  }

  async function expand(input: TransformExpandInput): Promise<ExpandResult> {
    const { query, language, protectedTokens, signal } = input;
    const maxItems = Math.max(0, Math.floor(input.maxItems));
    if (maxItems === 0) return { variants: [], skipped: [] };

    const capture = new CaptureRetriever();
    const text = renderPrompt(
      loadPrompt(MULTI_QUERY_ID, { [MULTI_QUERY_ID]: multiQueryPrompt }),
      { query_count: String(maxItems), question: query },
      { language, maxItems, protectedTokens },
    );
    const retriever = MultiQueryRetriever.fromLLM({
      // LLMChain accepts any runnable at run time (it pipes the parser onto it); the type asks for a language model.
      llm: boundModel(options, 'expand', signal) as unknown as BaseLanguageModelInterface,
      retriever: capture,
      prompt: ChatPromptTemplate.fromMessages([new HumanMessage(text)]),
      queryCount: maxItems,
      callbacks: [],
    });
    try {
      await raceAbort(() => retriever.invoke(query, invokeConfig(signal)), signal, 'expand');
    } catch (error) {
      return { variants: [], skipped: [skipOrThrow(error, signal, 'expand')] };
    }

    const output = QueryVariantsSchema.safeParse({ queries: capture.queries.map((q) => q.trim()) });
    if (!output.success) return { variants: [], skipped: [{ transform: 'expand', reason: 'error' }] };
    return finish.expand(input, output.data.queries);
  }

  /** A native port of LangChain's websearch HyDE template; HydeRetriever is not used (it embeds and searches itself). */
  async function hyde(input: TransformHydeInput): Promise<HydeResult> {
    const { query, language, protectedTokens, signal } = input;
    const text = renderPrompt(loadPrompt(HYDE_ID, { [HYDE_ID]: hydePrompt }), { question: query }, { language, maxItems: 1, protectedTokens });
    let passage: string;
    try {
      const output = await structured(options.chatModelFactory('hyde'), 'HypotheticalDocument', [new HumanMessage(text)], signal, 'hyde');
      passage = output.passage;
    } catch (error) {
      return { variant: null, truncated: false, skipped: [skipOrThrow(error, signal, 'hyde')] };
    }
    return finish.hyde(input, passage);
  }

  /**
   * LangChain's query-decomposition prompt (vendored) as a literal system message, the query as the human message, and
   * withStructuredOutput SubQuestions. The shared finisher validates the wire bound and applies the D-15 cut to
   * max_sub_questions, so a longer list is cut, never discarded. A failure is a skip; an abort propagates.
   */
  async function decompose(input: TransformDecomposeInput): Promise<DecomposeResult> {
    const { query, language, protectedTokens, signal } = input;
    const limits = input.limits ?? finish.defaultLimits;
    const system = renderPrompt(loadPrompt(DECOMPOSE_ID, { [DECOMPOSE_ID]: decomposePrompt }), {}, { language, maxItems: limits.maxSubQuestions, protectedTokens });
    let output: unknown;
    try {
      output = await structuredRaw(options.chatModelFactory('decompose'), SUB_QUESTIONS_WIRE_JSON, 'SubQuestions', [new SystemMessage(system), new HumanMessage(query)], signal, 'decompose');
    } catch (error) {
      const adapterError = toAdapterError(error, signal, 'decompose');
      if (adapterError.kind === 'aborted') throw adapterError;
      return { variants: [], notCompound: false, skipped: [{ transform: 'decompose', reason: 'error' }] };
    }
    return finish.decompose(input, output);
  }

  /**
   * One structured QueryTranslation call per target with the shared translate prompt (research A-6: no LangChain
   * translate prompt exists, so this is plumbing only), all in parallel. Failures, aborts included, are per-target
   * skips, as on the native path.
   */
  async function translate(input: TransformTranslateInput): Promise<TranslateResult> {
    const requests = finish.translateRequests(input);
    if (requests.length === 0) return { variants: [], skipped: [] };
    const outcomes = await Promise.all(
      requests.map(async ({ target, system, prompt }): Promise<TranslateCallOutcome> => {
        try {
          const messages = [new SystemMessage(system), new HumanMessage(prompt)];
          const output = await structuredRaw(options.chatModelFactory('translate'), RAW_STRUCTURED_SCHEMAS.QueryTranslation, 'QueryTranslation', messages, input.signal, 'translate');
          return { target, output };
        } catch (error) {
          return { target, failure: toAdapterError(error, input.signal, 'translate').kind };
        }
      }),
    );
    return finish.translate(input, outcomes);
  }

  return Object.freeze({
    framework: 'langchain' as const,
    condense,
    expand,
    hyde,
    decompose,
    translate,
  });
}
