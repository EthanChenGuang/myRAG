import type { AnswerSentence } from '@/lib/rag-eval/contracts.generated';

export type SentenceMarkKind = 'uncited' | 'unsupported';
export const MARK_HREF_PREFIX = '#mark-';
export type SentenceOffsets = Pick<AnswerSentence, 'part' | 'start' | 'end' | 'text_hash'>;
export interface TextReplacement { start: number; end: number; text: string }
export interface PlannedMark { id: string; kind: SentenceMarkKind; part: number; index: number; at: number }

export function markHref(kind: SentenceMarkKind, part: number, index: number): string {
  return `${MARK_HREF_PREFIX}${kind}-${part}-${index}`;
}
export function markFromHref(_href: unknown, _shown: ReadonlySet<string>): { kind: SentenceMarkKind; part: number; index: number } | null {
  return null;
}
export function verifySentenceRecordsSync<T extends SentenceOffsets>(_parts: readonly string[], _records: readonly T[]): T[] | undefined {
  return undefined;
}
export async function verifySentenceRecords<T extends SentenceOffsets>(_parts: readonly string[], _records: readonly T[]): Promise<T[]> {
  return [];
}
export function sentenceMarkKinds(_sentences: readonly AnswerSentence[], _checked: readonly AnswerSentence[]): Map<string, SentenceMarkKind[]> {
  return new Map();
}
export function planSentenceMarks(_text: string, _records: readonly AnswerSentence[], _kinds: ReadonlyMap<string, readonly SentenceMarkKind[]>): PlannedMark[] {
  return [];
}
export function insertSentenceMarks(text: string, _records: readonly AnswerSentence[], _kinds: ReadonlyMap<string, readonly SentenceMarkKind[]>, _replacements: readonly TextReplacement[] = []): string {
  return text;
}
