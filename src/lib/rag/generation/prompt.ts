import { RAG_MODE_CONFIGS } from '@/lib/rag-mode';
import { answerLanguageInstruction, type AnswerLanguageOptions } from './answer-language';
import { buildDecomposedAnswerBlock, type DecomposedAnswerInput } from './decomposed-answer';

export interface EnhancedPromptOptions extends AnswerLanguageOptions {
  /** 06.2 D-11: set by the caller only while RAG_DECOMPOSED_ANSWER is effective and the plan has sub-questions. */
  decomposedAnswer?: DecomposedAnswerInput;
}

export function createEnhancedRAGPrompt(
  basePrompt: string,
  context: string,
  mode: 'strict' | 'balanced' | 'flexible' | 'bypass' = 'strict',
  options?: EnhancedPromptOptions,
): string {
  const prompt = wrapPrompt(basePrompt, context, mode);
  const line = answerLanguageInstruction(options);
  const withLanguage = line ? `${prompt}\n\n${line}` : prompt;
  const block = options?.decomposedAnswer ? buildDecomposedAnswerBlock(options.decomposedAnswer) : null;
  return block ? `${withLanguage}\n\n${block}` : withLanguage;
}

function wrapPrompt(basePrompt: string, context: string, mode: 'strict' | 'balanced' | 'flexible' | 'bypass'): string {
  if (mode === 'bypass') {
    return basePrompt.replace('{{context}}', '').replace(/Context:\s*$/i, '').trim();
  }

  const modeConfig = RAG_MODE_CONFIGS[mode];
  if (!modeConfig || !modeConfig.systemPromptWrapper) {
    console.warn(`[RAG MODE] Unknown mode "${mode}", falling back to strict`);
    return wrapPrompt(basePrompt, context, 'strict');
  }

  const cleanedBasePrompt = basePrompt.replace('{{context}}', '').replace(/Context:\s*$/i, '').trim();

  return modeConfig.systemPromptWrapper.replace('{{basePrompt}}', () => cleanedBasePrompt).replace('{{context}}', () => context);
}
