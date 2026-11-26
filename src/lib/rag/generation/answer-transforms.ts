import type { StreamTextTransform, ToolSet } from 'ai';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import type { AnswerChannel } from './answer-turn';

type Transform = StreamTextTransform<ToolSet>;

export interface AnswerTransformParts {
  citationTransforms: readonly Transform[];
  sentinel?: Transform | null;
  /** Reserved for Phase 5.2.1's calculation-block transform. */
  calcBlock?: Transform | null;
  /** Filled by plan 05.2-13 (output guard). */
  guard?: Transform | null;
  /** The notice transform and the collector, in that order; always last. */
  noticeCollector?: readonly Transform[] | null;
}

export function buildAnswerTransforms(_parts: AnswerTransformParts): Transform[] {
  return [];
}

export interface AnswerTextPipelineOptions {
  refusalText?: string | null;
  finishReason?: string | null;
  language: string | null;
  channel: AnswerChannel;
  notices?: boolean;
}

export interface AnswerTextPipelineResult {
  text: string;
  refused: boolean;
  strippedCount: number;
  notices: AnswerNotice[];
  truncated: boolean;
}

export function applyAnswerPipelineToText(_text: string | readonly string[], _options: AnswerTextPipelineOptions): AnswerTextPipelineResult {
  return { text: '', refused: false, strippedCount: 0, notices: [], truncated: false };
}
