import type { TerminologyEntry, TerminologyValidationIssue } from '@/lib/rag-eval/contracts.generated';

export interface TerminologyValidationContext {
  layer: TerminologyEntry['layer'];
  current: readonly TerminologyEntry[];
  shared?: readonly TerminologyEntry[];
  enabledLanguages: readonly string[];
  minHanChars?: number;
}

export function validateEntries(_candidates: readonly TerminologyEntry[], _context: TerminologyValidationContext): TerminologyValidationIssue[] {
  return [];
}
