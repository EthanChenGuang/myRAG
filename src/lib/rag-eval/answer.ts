import { generateText, type LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { env } from '@/lib/env';
import { SystemPromptManager } from '@/lib/system-prompt-manager';
import { createEnhancedRAGPrompt, type AnswerLanguageOptions } from '@/lib/rag';
import type { GroundednessRequest, GroundednessResult } from '@/lib/rag-eval/contracts.generated';

export const EVAL_DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant with access to a knowledge base. When answering questions:

1. If the context contains relevant information, use it to provide accurate and specific answers
2. If information is not available in the context, say so clearly and suggest alternative approaches
3. Always cite your sources when referencing specific documents
4. Provide balanced, objective information rather than opinions
5. For technical topics, include practical steps or examples when appropriate

Context:
{{context}}`;

const FALLBACK_GENERATOR_MODEL = 'anthropic/claude-sonnet-4.5';

export type EvalRagMode = 'strict' | 'balanced' | 'flexible';

export interface EvalPromptEnv {
  RAG_PRE_CONTEXT?: string;
  RAG_POST_CONTEXT?: string;
  RAG_SYSTEM_PROMPT?: string;
}

export interface EvalConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type EvalLanguageModelFactory = (_modelId: string) => LanguageModel;

const defaultFactory: EvalLanguageModelFactory = (modelId) => {
  const provider = createOpenRouter({
    apiKey: env.OPENROUTER_API_KEY || '',
    baseURL: 'https://openrouter.ai/api/v1',
  });
  return provider(modelId) as unknown as LanguageModel;
};

let currentFactory: EvalLanguageModelFactory = defaultFactory;

export function setEvalLanguageModelFactory(factory: EvalLanguageModelFactory | null): void {
  currentFactory = factory ?? defaultFactory;
}

export type EvalGroundednessRequest = (
  _request: GroundednessRequest,
  _options?: { timeoutMs?: number },
) => Promise<GroundednessResult>;

let currentGroundednessRequest: EvalGroundednessRequest | null = null;

/** Harness seam: the eval route sends groundedness requests through this function instead of RAG_SIDECAR_URL. */
export function setEvalGroundednessRequest(request: EvalGroundednessRequest | null): void {
  currentGroundednessRequest = request;
}

export function evalGroundednessRequest(): EvalGroundednessRequest | null {
  return currentGroundednessRequest;
}

/** The chat route's system prompt template, with its {{context}} placeholder, as the eval resolves it. */
export function resolveEvalPromptTemplate(promptEnvInput?: EvalPromptEnv): string {
  const promptEnv: EvalPromptEnv = promptEnvInput ?? env;

  let ragSystemPrompt = EVAL_DEFAULT_SYSTEM_PROMPT;
  if (promptEnv.RAG_PRE_CONTEXT || promptEnv.RAG_POST_CONTEXT || promptEnv.RAG_SYSTEM_PROMPT) {
    if (promptEnv.RAG_PRE_CONTEXT || promptEnv.RAG_POST_CONTEXT) {
      const preContext = (promptEnv.RAG_PRE_CONTEXT || '').replace(/\\n/g, '\n');
      const postContext = (promptEnv.RAG_POST_CONTEXT || '').replace(/\\n/g, '\n');
      ragSystemPrompt = preContext + '\n\nContext:\n{{context}}\n\n' + postContext;
    } else if (promptEnv.RAG_SYSTEM_PROMPT) {
      ragSystemPrompt = promptEnv.RAG_SYSTEM_PROMPT.replace(/\\n/g, '\n');
    }
  }

  return SystemPromptManager.ensureContextPlaceholder(ragSystemPrompt);
}

export function buildEvalSystemPrompt(input: {
  context: string;
  ragMode: EvalRagMode;
  promptEnv?: EvalPromptEnv;
  /** D-25: the query plan's language and the kept chunks' languages (the trace has a query plan). */
  answerLanguage?: AnswerLanguageOptions;
}): string {
  const { context, ragMode, answerLanguage } = input;
  const ragSystemPrompt = resolveEvalPromptTemplate(input.promptEnv);

  if (context.length > 0) {
    return createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode, answerLanguage);
  }
  return SystemPromptManager.injectContext(ragSystemPrompt, context);
}

export function resolveGeneratorModel(requested?: string | null): string {
  if (requested) return requested;
  try {
    const models: unknown = JSON.parse(env.NEXT_PUBLIC_OPENROUTER_MODELS || '[]');
    if (Array.isArray(models)) {
      const entry = models.find(
        (candidate): candidate is { id: string } =>
          typeof candidate === 'object' &&
          candidate !== null &&
          (candidate as { isDefault?: unknown }).isDefault === true &&
          typeof (candidate as { id?: unknown }).id === 'string',
      );
      if (entry) return entry.id;
    }
  } catch {
    return FALLBACK_GENERATOR_MODEL;
  }
  return FALLBACK_GENERATOR_MODEL;
}

export function isGPTGeneratorModel(modelId: string): boolean {
  return modelId.includes('gpt-4') || modelId.includes('o1') || modelId.includes('chatgpt');
}

function maxOutputTokensForModel(modelId: string): number {
  if (modelId.includes('claude-sonnet-4') || modelId.includes('claude-4-sonnet')) return 16384;
  if (modelId.includes('claude-opus-4') || modelId.includes('claude-4-opus')) return 16384;
  if (modelId.includes('claude-3.7') || modelId.includes('claude-3.8')) return 8192;
  if (modelId.includes('claude') || modelId.includes('anthropic')) return 4096;
  if (modelId.includes('gpt-5-mini')) return 8192;
  if (modelId.includes('gpt-5')) return 4096;
  if (modelId.includes('gpt-4.1-mini')) return 8192;
  if (modelId.includes('gpt-4.1')) return 4096;
  if (modelId.includes('llama')) return 4096;
  return 4096;
}

export function buildEvalMessages(query: string, conversation: EvalConversationTurn[] = []): EvalConversationTurn[] {
  return [...conversation.map((turn) => ({ role: turn.role, content: turn.content })), { role: 'user', content: query }];
}

export async function generateEvalAnswer(input: {
  query: string;
  conversation?: EvalConversationTurn[];
  context: string;
  ragMode: EvalRagMode;
  generatorModel: string;
  signal?: AbortSignal;
  promptEnv?: EvalPromptEnv;
  /** Applied to the finished system prompt, e.g. the citation instruction. */
  decorateSystemPrompt?: (prompt: string) => string;
  answerLanguage?: AnswerLanguageOptions;
}): Promise<string> {
  const { query, conversation, context, ragMode, generatorModel, signal, promptEnv, decorateSystemPrompt, answerLanguage } = input;
  const basePrompt = buildEvalSystemPrompt({ context, ragMode, promptEnv, answerLanguage });
  const system = decorateSystemPrompt ? decorateSystemPrompt(basePrompt) : basePrompt;
  const result = await generateText({
    model: currentFactory(generatorModel),
    system,
    messages: buildEvalMessages(query, conversation),
    temperature: 0.1,
    maxOutputTokens: maxOutputTokensForModel(generatorModel),
    abortSignal: signal,
  });
  return result.text;
}
