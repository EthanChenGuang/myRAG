/** Phase 5 answer-quality UI strings (citation chips, the sources panel, the groundedness badge and answer feedback). Locales other than en, zh and it use en. */
export interface AnswerQualityStrings {
  citationsHeading: string;
  citedLabel: string;
  documentUpdatedOrRemoved: string;
  chipAriaLabel: (n: number) => string;
  pageLabel: (page: number) => string;
  badgeLabels: Record<'verified' | 'possibly_unreliable' | 'not_checked', string>;
  badgeTooltips: Record<'verified' | 'possibly_unreliable' | 'not_checked', string>;
  helpfulLabel: string;
  notHelpfulLabel: string;
  feedbackReasons: Record<'wrong' | 'incomplete' | 'not_from_documents' | 'bad_citation', string>;
  feedbackReasonHeading: string;
  feedbackCommentLabel: string;
  feedbackCommentPlaceholder: string;
  feedbackCharactersLeft: (n: number) => string;
  feedbackSubmit: string;
  feedbackCancel: string;
  feedbackSaved: string;
  feedbackFailed: string;
  relatedHeading: string;
  refusalGroupLabel: string;
  refusalExpectedAnswer: string;
  refusalCorrect: string;
  refusalReasons: Record<'answer_exists' | 'wrong_language' | 'other', string>;
  refusalFailed: string;
  refusalRetry: string;
}

const STRINGS: Record<string, AnswerQualityStrings> = {
  en: {
    citationsHeading: 'Cited in This Answer',
    citedLabel: 'Cited',
    documentUpdatedOrRemoved: 'This document has since been updated or removed. The quote above is the text the answer used.',
    chipAriaLabel: (n) => `Show source ${n}`,
    pageLabel: (page) => `p. ${page}`,
    badgeLabels: { verified: 'Verified', possibly_unreliable: 'Possibly Unreliable', not_checked: 'Not Checked' },
    badgeTooltips: {
      verified: 'An automatic check found this answer supported by your documents.',
      possibly_unreliable: 'An automatic check found parts of this answer that your documents may not support.',
      not_checked: 'This answer could not be checked against your documents.',
    },
    helpfulLabel: 'Helpful',
    notHelpfulLabel: 'Not Helpful',
    feedbackReasons: { wrong: 'Wrong', incomplete: 'Incomplete', not_from_documents: 'Not From My Documents', bad_citation: 'Bad Citation' },
    feedbackReasonHeading: 'What Went Wrong? (Optional)',
    feedbackCommentLabel: 'Add a Comment',
    feedbackCommentPlaceholder: 'For example, the date in the second paragraph is wrong…',
    feedbackCharactersLeft: (n) => `${n} characters left`,
    feedbackSubmit: 'Send Feedback',
    feedbackCancel: 'Cancel',
    feedbackSaved: 'Thanks for your feedback.',
    feedbackFailed: 'Feedback could not be saved. Try again.',
    relatedHeading: 'Related',
    refusalGroupLabel: 'Was This Refusal Right?',
    refusalExpectedAnswer: 'I Expected an Answer',
    refusalCorrect: 'Correct, Not in My Documents',
    refusalReasons: { answer_exists: 'The Answer Is in My Documents', wrong_language: 'Wrong Language', other: 'Other' },
    refusalFailed: 'Your feedback was not saved.',
    refusalRetry: 'Try Again',
  },
  zh: {
    citationsHeading: '本回答引用的内容',
    citedLabel: '已引用',
    documentUpdatedOrRemoved: '该文档此后已被更新或删除。上方引文是回答当时使用的内容。',
    chipAriaLabel: (n) => `查看来源 ${n}`,
    pageLabel: (page) => `第 ${page} 页`,
    badgeLabels: { verified: '已核验', possibly_unreliable: '可能不可靠', not_checked: '未核验' },
    badgeTooltips: {
      verified: '自动检查认为这条回答有你的文档支持。',
      possibly_unreliable: '自动检查发现这条回答的部分内容可能没有文档支持。',
      not_checked: '这条回答无法与你的文档进行核对。',
    },
    helpfulLabel: '有帮助',
    notHelpfulLabel: '没有帮助',
    feedbackReasons: { wrong: '内容错误', incomplete: '不完整', not_from_documents: '不是来自我的文档', bad_citation: '引用不对' },
    feedbackReasonHeading: '哪里有问题？（可选）',
    feedbackCommentLabel: '补充说明',
    feedbackCommentPlaceholder: '例如：第二段里的日期不对…',
    feedbackCharactersLeft: (n) => `还可输入 ${n} 个字符`,
    feedbackSubmit: '提交反馈',
    feedbackCancel: '取消',
    feedbackSaved: '感谢你的反馈。',
    feedbackFailed: '反馈未能保存，请重试。',
    relatedHeading: '相关问题',
    refusalGroupLabel: '这次拒答对吗？',
    refusalExpectedAnswer: '我认为应该有答案',
    refusalCorrect: '没错，我的文档里没有',
    refusalReasons: { answer_exists: '答案就在我的文档里', wrong_language: '语言不对', other: '其他' },
    refusalFailed: '反馈未能保存。',
    refusalRetry: '重试',
  },
  it: {
    citationsHeading: 'Citato in questa risposta',
    citedLabel: 'Citato',
    documentUpdatedOrRemoved: 'Questo documento è stato aggiornato o rimosso. La citazione qui sopra è il testo usato dalla risposta.',
    chipAriaLabel: (n) => `Mostra la fonte ${n}`,
    pageLabel: (page) => `p. ${page}`,
    badgeLabels: { verified: 'Verificata', possibly_unreliable: 'Forse inaffidabile', not_checked: 'Non verificata' },
    badgeTooltips: {
      verified: 'Un controllo automatico ha trovato questa risposta supportata dai tuoi documenti.',
      possibly_unreliable: 'Un controllo automatico ha trovato parti di questa risposta che i tuoi documenti potrebbero non supportare.',
      not_checked: 'Non è stato possibile verificare questa risposta sui tuoi documenti.',
    },
    helpfulLabel: 'Utile',
    notHelpfulLabel: 'Non utile',
    feedbackReasons: { wrong: 'Sbagliata', incomplete: 'Incompleta', not_from_documents: 'Non dai miei documenti', bad_citation: 'Citazione errata' },
    feedbackReasonHeading: 'Cosa non va? (facoltativo)',
    feedbackCommentLabel: 'Aggiungi un commento',
    feedbackCommentPlaceholder: 'Ad esempio, la data nel secondo paragrafo è sbagliata…',
    feedbackCharactersLeft: (n) => `${n} caratteri rimasti`,
    feedbackSubmit: 'Invia feedback',
    feedbackCancel: 'Annulla',
    feedbackSaved: 'Grazie per il feedback.',
    feedbackFailed: 'Non è stato possibile salvare il feedback. Riprova.',
    relatedHeading: 'Domande correlate',
    refusalGroupLabel: 'Questo rifiuto era giusto?',
    refusalExpectedAnswer: 'Mi aspettavo una risposta',
    refusalCorrect: 'Corretto, non è nei miei documenti',
    refusalReasons: { answer_exists: 'La risposta è nei miei documenti', wrong_language: 'Lingua sbagliata', other: 'Altro' },
    refusalFailed: 'Il feedback non è stato salvato.',
    refusalRetry: 'Riprova',
  },
};

export function answerQualityStrings(language: string): AnswerQualityStrings {
  return Object.prototype.hasOwnProperty.call(STRINGS, language) ? STRINGS[language] : STRINGS.en;
}
