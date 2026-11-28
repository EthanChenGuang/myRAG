/**
 * Phase 5.2.1 D-80, D-84: the route-side inputs of the prompt budget that every caller reads the same way: the document target
 * of the loaded configuration, and the registry text of the structured prompt_budget_exceeded error.
 */
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { fixedText } from '../lang/texts';

export const PROMPT_BUDGET_EXCEEDED = 'prompt_budget_exceeded';

/** D-83, D-95: RAG_CONTEXT_TOKEN_BUDGET of the configuration this process loads, the target for both pipelines. */
export function currentDocumentTokenTarget(): number {
  return loadRagConfig(getRagDeps().ragEnv()).v2.tokenBudget;
}

/** D-84: notices.prompt_too_long in the answer language; without one, in the caller's fallback language (registry fallback rules). */
export function promptTooLongText(answerLanguage: string | null, fallbackLanguage: string): string {
  return fixedText('notices.prompt_too_long', answerLanguage ?? fallbackLanguage);
}

/** D-84, RESEARCH Pitfall B3: OpenRouter's context-compression plugin, disabled while the budget is on. */
export const OPENROUTER_COMPRESSION_OFF = Object.freeze({ id: 'context-compression', enabled: false });
