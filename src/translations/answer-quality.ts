export interface AnswerQualityStrings {
  citationsHeading: string;
  citedLabel: string;
  documentUpdatedOrRemoved: string;
  chipAriaLabel: (n: number) => string;
  pageLabel: (page: number) => string;
  sectionLabel: string;
}

const EN: AnswerQualityStrings = {
  citationsHeading: '',
  citedLabel: '',
  documentUpdatedOrRemoved: '',
  chipAriaLabel: () => '',
  pageLabel: () => '',
  sectionLabel: '',
};

export function answerQualityStrings(_language: string): AnswerQualityStrings {
  return EN;
}
