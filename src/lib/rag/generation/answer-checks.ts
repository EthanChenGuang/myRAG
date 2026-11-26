import { AnswerChecksSchema, type AnswerSentence, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
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

const FINISH_REASON = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * D-23, D-33: sentences (when computed for this turn), truncated and finish_reason, validated with the generated schema.
 * `citationRecords` and `retrievalResult` are read by later plans (claim check, version conflict).
 */
export function buildAnswerChecksInput(input: BuildAnswerChecksInput): AnswerChecksInput {
  const { collector } = input;
  const reason = collector.finishReason();
  const checks: AnswerChecksInput = {
    truncated: collector.truncated(),
    finish_reason: reason === null ? null : FINISH_REASON.test(reason) ? reason : 'other',
  };
  const sentences = collector.sentences();
  if (sentences) checks.sentences = sentences;
  AnswerChecksSchema.parse(checks);
  return checks;
}
