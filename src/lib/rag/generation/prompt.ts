import { RAG_MODE_CONFIGS } from '@/lib/rag-mode';

export function createEnhancedRAGPrompt(
  basePrompt: string,
  context: string,
  mode: 'strict' | 'balanced' | 'flexible' | 'bypass' = 'strict',
): string {
  if (mode === 'bypass') {
    return basePrompt.replace('{{context}}', '').replace(/Context:\s*$/i, '').trim();
  }

  const modeConfig = RAG_MODE_CONFIGS[mode];
  if (!modeConfig || !modeConfig.systemPromptWrapper) {
    console.warn(`[RAG MODE] Unknown mode "${mode}", falling back to strict`);
    return createEnhancedRAGPrompt(basePrompt, context, 'strict');
  }

  const cleanedBasePrompt = basePrompt.replace('{{context}}', '').replace(/Context:\s*$/i, '').trim();

  return modeConfig.systemPromptWrapper.replace('{{context}}', context).replace('{{basePrompt}}', cleanedBasePrompt);
}
