import type { AnswerConfig } from './answer-config';
import { previousTurnLanguage, resolveAnswerLanguage, type AnswerLanguageSource, type TurnMessage } from '../lang/answer-language';
import { getLanguageSettings, languageVariablesUnset } from '../lang/settings';

export type AnswerChannel = 'web' | 'whatsapp' | 'embed' | 'voice' | 'eval';
/** `registry`: fixed texts come from the language registry in the answer language; `legacy`: today's text tables (D-10). */
export type TextsSource = 'registry' | 'legacy';

/** The per-request answer state (D-64); created once per chat request. Later plans add their seams to it. */
export interface AnswerTurn {
  readonly config: AnswerConfig;
  /** D-09; null when no Phase 5.2 switch is on or the languages are not configured. */
  readonly answerLanguage: string | null;
  readonly answerLanguageSource: AnswerLanguageSource | null;
  readonly textsSource: TextsSource;
  readonly channel: AnswerChannel;
  readonly ragMode: string;
}

export interface AnswerTurnInput {
  config: AnswerConfig;
  question: string;
  /** The request's messages, the current question last; read only when the answer language is computed. */
  history: readonly TurnMessage[];
  /** Overrides the previous-turn language read from `history`. */
  previousTurnLanguage?: string | null;
  uiLanguage: string | null | undefined;
  channel: AnswerChannel;
  ragMode: string;
}

/** D-03: with every Phase 5.2 switch off, or the languages unset (D-02), no language setting is read and no detector runs. */
export function createAnswerTurn(input: AnswerTurnInput): AnswerTurn {
  let answerLanguage: string | null = null;
  let answerLanguageSource: AnswerLanguageSource | null = null;
  if (input.config.anyNonDefault && !languageVariablesUnset()) {
    const settings = getLanguageSettings();
    if (settings.configured && settings.primary) {
      const enabled = settings.languages;
      const resolved = resolveAnswerLanguage({
        question: input.question,
        previousTurnLanguage: input.previousTurnLanguage !== undefined ? input.previousTurnLanguage : previousTurnLanguage(input.history, enabled),
        uiLanguage: input.uiLanguage,
        enabled,
        primary: settings.primary,
      });
      answerLanguage = resolved.language;
      answerLanguageSource = resolved.source;
    }
  }
  return Object.freeze({
    config: input.config,
    answerLanguage,
    answerLanguageSource,
    textsSource: input.config.registryTexts && answerLanguage !== null ? 'registry' : 'legacy',
    channel: input.channel,
    ragMode: input.ragMode,
  });
}
