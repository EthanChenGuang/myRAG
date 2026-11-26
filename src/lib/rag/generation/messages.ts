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

/** The strict-mode "information not available" answer (knowledge base empty for the query, web search off). */
export function noKnowledgeBaseResponse(language: string): string {
  if (noKnowledgeBaseResponseLanguage(language) === 'es') {
    return `# Información no disponible

## Estado de la base de conocimiento
- No encontré esta información en tu base de conocimiento.
- La búsqueda web está desactivada, así que no puedo consultarla en línea.

¿Quieres que active la búsqueda web para verificarlo? ¿Prefieres subir un documento con esa información? ¿Hay algún detalle específico que deba buscar?`;
  }

  return `# Information Not Available

## Knowledge Base Status
- I couldn’t find this information in your knowledge base.
- Web search is turned off, so I can’t look it up online.

Would you like me to turn on web search and check? Do you want to upload a document that contains this information? Is there a specific detail you want me to focus on?`;
}

export function identifierSuggestionMessage(_language: string | null | undefined, _suggestions: readonly string[] | undefined): string {
  return '';
}
