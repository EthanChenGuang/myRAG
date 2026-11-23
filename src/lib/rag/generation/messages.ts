const UNAVAILABLE_MESSAGES: Record<string, string> = {
  en: 'The knowledge base is temporarily unavailable. Please try again in a moment.',
  zh: '知识库暂时无法访问，请稍后再试。',
  it: 'La base di conoscenza non è al momento disponibile. Riprova tra poco.',
  es: 'La base de conocimiento no está disponible temporalmente. Inténtalo de nuevo en un momento.',
};

export function knowledgeBaseUnavailableMessage(language: string): string {
  return Object.prototype.hasOwnProperty.call(UNAVAILABLE_MESSAGES, language)
    ? UNAVAILABLE_MESSAGES[language]
    : UNAVAILABLE_MESSAGES.en;
}
