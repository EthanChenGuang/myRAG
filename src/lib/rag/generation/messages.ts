import { fixedText } from '../lang/texts';
import type { TextsSource } from './answer-turn';

const UNAVAILABLE_MESSAGES: Record<string, string> = {
  en: 'The knowledge base is temporarily unavailable. Please try again in a moment.',
  zh: '知识库暂时无法访问，请稍后再试。',
  it: 'La base di conoscenza non è al momento disponibile. Riprova tra poco.',
  es: 'La base de conocimiento no está disponible temporalmente. Inténtalo de nuevo en un momento.',
};

/** The language code knowledgeBaseUnavailableMessage renders for a requested language; never the requested string itself. */
export function knowledgeBaseUnavailableLanguage(language: string): string {
  return Object.prototype.hasOwnProperty.call(UNAVAILABLE_MESSAGES, language) ? language : 'en';
}

export function knowledgeBaseUnavailableMessage(language: string): string {
  return UNAVAILABLE_MESSAGES[knowledgeBaseUnavailableLanguage(language)];
}

/** The language code noKnowledgeBaseResponse renders for a requested language; never the requested string itself. */
export function noKnowledgeBaseResponseLanguage(language: string): string {
  return language === 'es' ? 'es' : 'en';
}

/** Today's English strict refusal (moved verbatim from the chat route); registry `notices.no_information` (en) equals it (D-10). */
export const LEGACY_NO_INFORMATION_EN = `# Information Not Available

## Knowledge Base Status
- I couldn’t find this information in your knowledge base.
- Web search is turned off, so I can’t look it up online.

Would you like me to turn on web search and check? Do you want to upload a document that contains this information? Is there a specific detail you want me to focus on?`;

/** Today's Spanish strict refusal; the registry has no Spanish pack, so it serves only the legacy text source (D-10). */
export const LEGACY_NO_INFORMATION_ES = `# Información no disponible

## Estado de la base de conocimiento
- No encontré esta información en tu base de conocimiento.
- La búsqueda web está desactivada, así que no puedo consultarla en línea.

¿Quieres que active la búsqueda web para verificarlo? ¿Prefieres subir un documento con esa información? ¿Hay algún detalle específico que deba buscar?`;

/** The strict-mode "information not available" answer (knowledge base empty for the query, web search off). */
export function noKnowledgeBaseResponse(language: string): string {
  return noKnowledgeBaseResponseLanguage(language) === 'es' ? LEGACY_NO_INFORMATION_ES : LEGACY_NO_INFORMATION_EN;
}

/** The part of an AnswerTurn the fixed texts read; `answerLanguage` is set whenever `textsSource` is `registry`. */
export interface FixedTextTurn {
  readonly textsSource: TextsSource;
  readonly answerLanguage: string | null;
}

function registryLanguage(turn: FixedTextTurn | null | undefined): string | null {
  return turn?.textsSource === 'registry' && turn.answerLanguage ? turn.answerLanguage : null;
}

/** D-10: the strict refusal; legacy source keeps today's UI-language and Spanish-heuristic choice, registry reads the answer language. */
export function noInformationText(turn: FixedTextTurn | null | undefined, legacyLanguage: string): string {
  const language = registryLanguage(turn);
  return language ? fixedText('notices.no_information', language) : noKnowledgeBaseResponse(legacyLanguage);
}

/** The language code noInformationText renders. */
export function noInformationLanguage(turn: FixedTextTurn | null | undefined, legacyLanguage: string): string {
  return registryLanguage(turn) ?? noKnowledgeBaseResponseLanguage(legacyLanguage);
}

/** D-10: the knowledge-base-unavailable message, by the same rule as noInformationText. */
export function kbUnavailableText(turn: FixedTextTurn | null | undefined, legacyLanguage: string): string {
  const language = registryLanguage(turn);
  return language ? fixedText('notices.kb_unavailable', language) : knowledgeBaseUnavailableMessage(legacyLanguage);
}

/** The language code kbUnavailableText renders. */
export function kbUnavailableLanguage(turn: FixedTextTurn | null | undefined, legacyLanguage: string): string {
  return registryLanguage(turn) ?? knowledgeBaseUnavailableLanguage(legacyLanguage);
}

const IDENTIFIER_SUGGESTION_MESSAGES: Record<string, (list: string) => string> = {
  en: (list) => `No passage names the identifier you asked about. Closest existing identifiers: ${list}.`,
  zh: (list) => `没有找到提到您所问标识符的内容。最接近的现有标识符：${list}。`,
  it: (list) => `Nessun passaggio cita l'identificativo richiesto. Identificativi esistenti più vicini: ${list}.`,
};

const SUGGESTION_UNSAFE = /[\p{Cc}\p{Cf}<>`]/gu;

/**
 * D-31: the localized sentence that names up to three existing identifiers of the caller's tenant (zh, en, it; other languages en).
 * Suggestions are rendered as plain text without markup or control characters; no suggestion gives an empty string.
 */
export function identifierSuggestionMessage(language: string | null | undefined, suggestions: readonly string[] | undefined): string {
  const list = (suggestions ?? [])
    .map((value) => value.replace(SUGGESTION_UNSAFE, '').trim())
    .filter((value) => value.length > 0)
    .slice(0, 3);
  if (list.length === 0) return '';
  const key = language && Object.prototype.hasOwnProperty.call(IDENTIFIER_SUGGESTION_MESSAGES, language) ? language : 'en';
  return IDENTIFIER_SUGGESTION_MESSAGES[key]!(list.join(key === 'zh' ? '、' : ', '));
}
