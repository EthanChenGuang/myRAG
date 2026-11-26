import type { AnswerConfig } from './answer-config';
import { composeAnswerRules } from './answer-rules';
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
  /** D-32; false until plan 05.2-10 sets it from the output-cap rules. */
  readonly capApplies: boolean;
  /** D-04: appends the answer-rule block to the final system prompt; returns the prompt itself when no part applies. */
  composeSystemPrompt(prompt: string, options: ComposeSystemPromptOptions): string;
}

export interface ComposeSystemPromptOptions {
  mode: string;
  webSearchOffered: boolean;
  contextTagging: boolean;
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
  const capApplies = false;
  let logged = false;
  return Object.freeze({
    config: input.config,
    answerLanguage,
    answerLanguageSource,
    textsSource: input.config.registryTexts && answerLanguage !== null ? 'registry' : 'legacy',
    channel: input.channel,
    ragMode: input.ragMode,
    capApplies,
    composeSystemPrompt(prompt: string, options: ComposeSystemPromptOptions): string {
      const composed = composeAnswerRules(
        {
          prompt,
          mode: options.mode,
          language: answerLanguage,
          config: input.config,
          channel: input.channel,
          webSearchOffered: options.webSearchOffered,
          capApplies,
          calcOffered: false,
          contextTagging: options.contextTagging,
        },
        { log: !logged },
      );
      if (composed !== prompt) logged = true;
      return composed;
    },
  });
}
