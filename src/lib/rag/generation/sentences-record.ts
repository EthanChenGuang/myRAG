import type { AnswerSentence } from '@/lib/rag-eval/contracts.generated';
import type { AnswerSentenceUnit } from '../lang/sentences';

export interface ExemptionTexts {
  phrases: readonly string[];
}

export interface ExemptionContext {
  texts: ExemptionTexts;
  inUnsourcedPart: boolean;
}

export interface SentenceRecordInput {
  text: string;
  part: number;
  language: string;
  aliases: ReadonlySet<string>;
  sourceRanges?: ReadonlyArray<{ start: number; end: number }>;
  truncated?: boolean;
}

export function answerTextHash(_text: string): string {
  return '';
}

export function exemptionTexts(_language: string): ExemptionTexts {
  return { phrases: [] };
}

export function isExemptSentence(_unit: AnswerSentenceUnit, _context: ExemptionContext): boolean {
  return false;
}

export function buildSentenceRecords(_input: SentenceRecordInput): AnswerSentence[] {
  return [];
}
