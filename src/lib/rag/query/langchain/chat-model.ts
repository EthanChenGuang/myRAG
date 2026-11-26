import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessageLike } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import {
  CondensedQuerySchema,
  HypotheticalDocumentSchema,
  QueryVariantsSchema,
  type CondensedQuery,
  type HypotheticalDocument,
  type QueryVariants,
} from '@/lib/rag-eval/contracts.generated';
import condensedQueryJson from '../../../../../rag-sidecar/schemas/CondensedQuery.schema.json';
import hypotheticalDocumentJson from '../../../../../rag-sidecar/schemas/HypotheticalDocument.schema.json';
import queryVariantsJson from '../../../../../rag-sidecar/schemas/QueryVariants.schema.json';
import { LangChainAdapterError, raceAbort, type LangChainTransform } from './errors';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** The same OpenRouter routing preferences as the native query LLM: no data collection, parameters required. */
export const OPENROUTER_PROVIDER_PREFERENCES = Object.freeze({ require_parameters: true, data_collection: 'deny', sort: 'latency' });

export interface ChatModelOptions {
  /** RAG_QUERY_LLM_MODEL, read by transformer.ts; the adapter imports no env module (D-18). */
  model: string;
  /** The OpenRouter key, passed in by transformer.ts. */
  apiKey: string | undefined;
  /** Optional OpenRouter attribution headers, built by the caller. */
  headers?: Readonly<Record<string, string>>;
}

/** Builds the chat model for one call; transformer.ts passes () => createChatModel(...), tests pass the fake. */
export type ChatModelFactory = () => BaseChatModel;

/**
 * ChatOpenAI against OpenRouter (D-20, D-21, research P-10): explicit baseURL (wins over LANGSMITH_GATEWAY routing),
 * temperature 0, maxRetries 0 (the AsyncCaller default is 6) and no callbacks. An empty key is refused here so ChatOpenAI
 * never falls back to OPENAI_API_KEY and sends it to OpenRouter.
 */
export function createChatModel(options: ChatModelOptions, transform: LangChainTransform = 'condense'): BaseChatModel {
  const apiKey = (options.apiKey ?? '').trim();
  const model = options.model.trim();
  if (apiKey === '' || model === '') throw new LangChainAdapterError('unavailable', transform);
  return new ChatOpenAI({
    model,
    apiKey,
    temperature: 0,
    maxRetries: 0,
    callbacks: [],
    modelKwargs: { provider: { ...OPENROUTER_PROVIDER_PREFERENCES } },
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      maxRetries: 0,
      ...(options.headers ? { defaultHeaders: { ...options.headers } } : {}),
    },
  });
}

/** The part of a generated zod/v3 schema the adapter uses; the adapter may not import zod itself (D-18 allow-list). */
type SafeParser<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
type StructuredContract<T> = { json: Record<string, unknown>; zod: SafeParser<T> };

export const STRUCTURED_CONTRACTS = Object.freeze({
  CondensedQuery: { json: condensedQueryJson, zod: CondensedQuerySchema } as StructuredContract<CondensedQuery>,
  QueryVariants: { json: queryVariantsJson, zod: QueryVariantsSchema } as StructuredContract<QueryVariants>,
  HypotheticalDocument: { json: hypotheticalDocumentJson, zod: HypotheticalDocumentSchema } as StructuredContract<HypotheticalDocument>,
});

export type StructuredContractName = keyof typeof STRUCTURED_CONTRACTS;
type ContractOutput<N extends StructuredContractName> = (typeof STRUCTURED_CONTRACTS)[N] extends StructuredContract<infer T> ? T : never;

/** Every LangChain invoke gets the request signal and no callbacks. */
export function invokeConfig(signal: AbortSignal): { signal: AbortSignal; callbacks: [] } {
  return { signal, callbacks: [] };
}

/**
 * One structured call: withStructuredOutput with the generated JSON Schema (method jsonSchema, so response_format),
 * then the generated zod/v3 schema again at the adapter boundary. An output that fails it is invalid_output.
 */
export async function structured<N extends StructuredContractName>(
  chatModel: BaseChatModel,
  contract: N,
  messages: BaseMessageLike[],
  signal: AbortSignal,
  transform: LangChainTransform,
): Promise<ContractOutput<N>> {
  const { json, zod } = STRUCTURED_CONTRACTS[contract] as StructuredContract<ContractOutput<N>>;
  const runnable = chatModel.withStructuredOutput(json, { method: 'jsonSchema', name: contract });
  const output = await raceAbort(() => runnable.invoke(messages, invokeConfig(signal)), signal, transform);
  const parsed = zod.safeParse(output);
  if (!parsed.success) throw new LangChainAdapterError('invalid_output', transform);
  return parsed.data;
}
