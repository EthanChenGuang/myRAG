export type AnswerLanguageSource = 'question' | 'previous_turn' | 'ui' | 'primary';

export interface AnswerLanguage {
  readonly language: string;
  readonly source: AnswerLanguageSource;
  readonly confident: boolean;
}

export interface AnswerLanguageInput {
  question: string;
  previousTurnLanguage: string | null | undefined;
  uiLanguage: string | null | undefined;
  enabled: readonly string[];
  primary: string;
}

export interface TurnMessage {
  readonly role: string;
  readonly content: unknown;
  readonly metadata?: unknown;
}

export function resolveAnswerLanguage(input: AnswerLanguageInput): AnswerLanguage {
  return { language: input.primary, source: 'primary', confident: false };
}

export function previousTurnLanguage(_messages: readonly TurnMessage[], _enabled: readonly string[]): string | null {
  return null;
}
