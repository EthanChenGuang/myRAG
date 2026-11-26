import type { AnswerConfig } from './answer-config';
import type { AnswerLanguageSource, TurnMessage } from '../lang/answer-language';

export type AnswerChannel = 'web' | 'whatsapp' | 'embed' | 'voice' | 'eval';
export type TextsSource = 'registry' | 'legacy';

export interface AnswerTurn {
  readonly config: AnswerConfig;
  readonly answerLanguage: string | null;
  readonly answerLanguageSource: AnswerLanguageSource | null;
  readonly textsSource: TextsSource;
  readonly channel: AnswerChannel;
  readonly ragMode: string;
}

export interface AnswerTurnInput {
  config: AnswerConfig;
  question: string;
  history: readonly TurnMessage[];
  previousTurnLanguage?: string | null;
  uiLanguage: string | null | undefined;
  channel: AnswerChannel;
  ragMode: string;
}

export function createAnswerTurn(input: AnswerTurnInput): AnswerTurn {
  return { config: input.config, answerLanguage: null, answerLanguageSource: null, textsSource: 'legacy', channel: input.channel, ragMode: input.ragMode };
}
