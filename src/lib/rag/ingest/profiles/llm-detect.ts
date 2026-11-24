import type { DocTypeDetection } from '@/lib/rag-eval/contracts.generated';

export const DOC_TYPE_LLM_MODEL_ID = 'google/gemini-2.5-flash-lite';

export interface LlmDetectInput {
  filename: string;
  text: string;
  signal: AbortSignal;
}

export type LlmDetectCall = (input: LlmDetectInput) => Promise<unknown>;

export type LlmDetectResult = { ok: true; detection: DocTypeDetection } | { ok: false; warning: string };

export function setLlmDetectForTests(_call: LlmDetectCall | null): void {}

export async function detectDocTypeWithLlm(_input: LlmDetectInput): Promise<LlmDetectResult> {
  return { ok: false, warning: 'llm_detect_unavailable' };
}
