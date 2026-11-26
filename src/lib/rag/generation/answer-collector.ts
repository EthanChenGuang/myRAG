import type { StreamTextTransform, ToolSet } from 'ai';
import type { AnswerNotice, AnswerSentence } from '@/lib/rag-eval/contracts.generated';
import type { AnswerConfig } from './answer-config';
import type { AnswerChannel } from './answer-turn';

export interface AnswerCollectorTurn {
  readonly config: Pick<AnswerConfig, 'anyNonDefault' | 'citationPerSentence' | 'claimCheck'>;
  readonly answerLanguage: string | null;
}

export interface AnswerCollectorInput {
  turn: AnswerCollectorTurn;
  channel: AnswerChannel;
  /** The validated aliases of this request's citation session; read once at stream end. */
  aliases?: () => ReadonlySet<string>;
}

export interface AnswerTextPart {
  index: number;
  text: string;
}

export interface AnswerCollector {
  transforms(): Array<StreamTextTransform<ToolSet>>;
  addNotice(notice: AnswerNotice): void;
  markRefused(): void;
  countStripped(count: number): void;
  finalText(): string;
  lastTextPart(): AnswerTextPart | null;
  refusedByModel(): boolean;
  finishReason(): string | null;
  truncated(): boolean;
  strippedSentinels(): number;
  notices(): AnswerNotice[];
  sentences(): AnswerSentence[] | null;
  finishMetadata(): Record<string, unknown>;
}

export function createAnswerCollector(_input: AnswerCollectorInput): AnswerCollector {
  return {
    transforms: () => [],
    addNotice() {},
    markRefused() {},
    countStripped() {},
    finalText: () => '',
    lastTextPart: () => null,
    refusedByModel: () => false,
    finishReason: () => null,
    truncated: () => false,
    strippedSentinels: () => 0,
    notices: () => [],
    sentences: () => null,
    finishMetadata: () => ({}),
  };
}
