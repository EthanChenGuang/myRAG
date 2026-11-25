import type { AnswerRecord, CitationRecord } from '@/lib/rag-eval/contracts.generated';

export type AnswerGroundedness = AnswerRecord['groundedness'];
export type AnswerFeedback = NonNullable<AnswerRecord['feedback']>;
export type AnswerCitationStrategy = CitationRecord['strategy'];

export interface AnswerMessageMetadata {
  answerId?: string;
  citations?: CitationRecord[];
  citationStrategy?: AnswerCitationStrategy;
  invalidCitations?: number;
  groundedness?: AnswerGroundedness;
  feedback?: AnswerFeedback;
}

export function pickAnswerMetadata(_metadata: unknown): AnswerMessageMetadata {
  return {};
}
