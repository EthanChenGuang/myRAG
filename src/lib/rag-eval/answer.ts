import { generateText, type LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { env } from '@/lib/env';
import { SystemPromptManager } from '@/lib/system-prompt-manager';
import { createEnhancedRAGPrompt } from '@/lib/thinking-rag-enhancer';

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

export function buildEvalSystemPrompt(input: {
  context: string;
  ragMode: EvalRagMode;
  promptEnv?: EvalPromptEnv;
}): string {
  const { context, ragMode } = input;
  const promptEnv: EvalPromptEnv = input.promptEnv ?? env;

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

  ragSystemPrompt = SystemPromptManager.ensureContextPlaceholder(ragSystemPrompt);

  if (context.length > 0) {
    return createEnhancedRAGPrompt(ragSystemPrompt, context, ragMode);
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

export async function generateEvalAnswer(input: {
  query: string;
  context: string;
  ragMode: EvalRagMode;
  generatorModel: string;
  signal?: AbortSignal;
  promptEnv?: EvalPromptEnv;
}): Promise<string> {
  const { query, context, ragMode, generatorModel, signal, promptEnv } = input;
  const system = buildEvalSystemPrompt({ context, ragMode, promptEnv });
  const result = await generateText({
    model: currentFactory(generatorModel),
    system,
    messages: [{ role: 'user', content: query }],
    temperature: 0.1,
    maxOutputTokens: maxOutputTokensForModel(generatorModel),
    abortSignal: signal,
  });
  return result.text;
}
