import type { AnswerSentence, CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { AnswerCollector } from './answer-collector';

/** The part of `checks` known at stream end (D-23); plans 05.2-13 and 05.2-22 add output_guard and version_conflict. */
export interface AnswerChecksInput {
  sentences?: AnswerSentence[];
  truncated: boolean;
  finish_reason: string | null;
}

export interface BuildAnswerChecksInput {
  collector: AnswerCollector;
  citationRecords?: readonly CitationRecord[] | null;
  retrievalResult?: unknown;
}

export function buildAnswerChecksInput(_input: BuildAnswerChecksInput): AnswerChecksInput {
  return { truncated: false, finish_reason: null };
}
