import type { ScopeTagSuggestion } from '@/lib/rag-eval/contracts.generated';
import type { ScopeDimension } from '../scopes/admin';

export interface ScopeVocabularyEntry {
  dimension: ScopeDimension;
  value: string;
  label: string;
  aliases: string[];
  active: boolean;
}

export interface SuggestScopeTagsInput {
  title: string;
  firstPage: string;
  vocabulary: readonly ScopeVocabularyEntry[];
  existing: readonly string[];
  llm?: { signal: AbortSignal } | null;
}

export interface SuggestScopeTagsOutput {
  suggestion: ScopeTagSuggestion;
  warnings: string[];
}

export interface ScopeSuggestLlmInput {
  title: string;
  text: string;
  vocabulary: Array<{ dimension: ScopeDimension; value: string; label: string }>;
  signal: AbortSignal;
}

export type ScopeSuggestLlmCall = (input: ScopeSuggestLlmInput) => Promise<unknown>;

export const MAX_SCOPE_LLM_TEXT_CHARS = 4000;

export function setScopeSuggestLlmForTests(_call: ScopeSuggestLlmCall | null): void {}

export async function suggestScopeTags(_input: SuggestScopeTagsInput): Promise<SuggestScopeTagsOutput> {
  return { suggestion: { suggestions: [] }, warnings: [] };
}
