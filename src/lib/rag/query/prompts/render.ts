import type { Lang } from '../rewrite-gate';
import sharedSuffix from './shared.suffix.v1.json';

export const HISTORY_OPEN = '<conversation>';
export const HISTORY_CLOSE = '</conversation>';

export type PromptFile = {
  id: string;
  version: number;
  source: string;
  license: string;
  template: string;
  placeholders: string[];
};

export type HistoryTurn = { role: 'user' | 'assistant'; content: string };
export type RenderOptions = { language: Lang; maxItems: number; protectedTokens: readonly string[]; history?: readonly HistoryTurn[] };

export const PROMPT_REGISTRY: Record<string, unknown> = { 'shared.suffix': sharedSuffix };

export function loadPrompt(id: string, registry: Record<string, unknown> = PROMPT_REGISTRY): PromptFile {
  return registry[id] as PromptFile;
}

export function renderPrompt(prompt: PromptFile, _vars: Record<string, string>, _options: RenderOptions): string {
  return prompt.template;
}
