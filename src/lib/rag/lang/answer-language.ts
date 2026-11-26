import { detectLanguageWithConfidence } from './detect';

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

/** A chat message as the request carries it; metadata is read only for `answerLanguage`. */
export interface TurnMessage {
  readonly role: string;
  readonly content: unknown;
  readonly metadata?: unknown;
}

function enabledCode(code: string | null | undefined, enabled: readonly string[]): string | null {
  return typeof code === 'string' && enabled.includes(code) ? code : null;
}

/**
 * Phase 5.2 D-09: the question's language among the enabled languages; when that detection is not confident, the previous turn,
 * then the UI language if it is enabled, then the primary language. Language codes only; the question is never logged.
 */
export function resolveAnswerLanguage(input: AnswerLanguageInput): AnswerLanguage {
  const detection = input.enabled.length > 0 ? detectLanguageWithConfidence(input.question, input.enabled) : null;
  const detected = detection?.confident ? enabledCode(detection.language, input.enabled) : null;
  if (detected) return { language: detected, source: 'question', confident: true };
  const previous = enabledCode(input.previousTurnLanguage, input.enabled);
  if (previous) return { language: previous, source: 'previous_turn', confident: false };
  const ui = enabledCode(input.uiLanguage, input.enabled);
  if (ui) return { language: ui, source: 'ui', confident: false };
  return { language: input.primary, source: 'primary', confident: false };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return '';
}

function metadataLanguage(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as { answerLanguage?: unknown }).answerLanguage;
  return typeof value === 'string' ? value : null;
}

/**
 * The language of the turn before the current question: the `answerLanguage` metadata of the last assistant message when present,
 * otherwise the confident detection of the user message before the current one; null without either.
 */
export function previousTurnLanguage(messages: readonly TurnMessage[], enabled: readonly string[]): string | null {
  let current = messages.length - 1;
  while (current >= 0 && messages[current]!.role !== 'user') current -= 1;
  for (let index = current - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') {
      const fromMetadata = enabledCode(metadataLanguage(message.metadata), enabled);
      if (fromMetadata) return fromMetadata;
      continue;
    }
    if (message.role !== 'user') continue;
    if (enabled.length === 0) return null;
    const detection = detectLanguageWithConfidence(messageText(message.content), enabled);
    return detection.confident ? enabledCode(detection.language, enabled) : null;
  }
  return null;
}
