/** Phase 5 answer-quality UI strings (citation chips and the sources panel). Locales other than en, zh and it use en. */
export interface AnswerQualityStrings {
  citationsHeading: string;
  citedLabel: string;
  documentUpdatedOrRemoved: string;
  chipAriaLabel: (n: number) => string;
  pageLabel: (page: number) => string;
}

const STRINGS: Record<string, AnswerQualityStrings> = {
  en: {
    citationsHeading: 'Cited in This Answer',
    citedLabel: 'Cited',
    documentUpdatedOrRemoved: 'This document has since been updated or removed. The quote above is the text the answer used.',
    chipAriaLabel: (n) => `Show source ${n}`,
    pageLabel: (page) => `p. ${page}`,
  },
  zh: {
    citationsHeading: '本回答引用的内容',
    citedLabel: '已引用',
    documentUpdatedOrRemoved: '该文档此后已被更新或删除。上方引文是回答当时使用的内容。',
    chipAriaLabel: (n) => `查看来源 ${n}`,
    pageLabel: (page) => `第 ${page} 页`,
  },
  it: {
    citationsHeading: 'Citato in questa risposta',
    citedLabel: 'Citato',
    documentUpdatedOrRemoved: 'Questo documento è stato aggiornato o rimosso. La citazione qui sopra è il testo usato dalla risposta.',
    chipAriaLabel: (n) => `Mostra la fonte ${n}`,
    pageLabel: (page) => `p. ${page}`,
  },
};

export function answerQualityStrings(language: string): AnswerQualityStrings {
  return Object.prototype.hasOwnProperty.call(STRINGS, language) ? STRINGS[language] : STRINGS.en;
}
