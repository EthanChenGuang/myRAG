const CITATION_INSTRUCTIONS: Record<string, string> = {
  en: 'Cite the sources you use with [S<number>] markers taken only from the labelled sources above, for example [S1] or [S1][S3]. Never cite a number that is not in a label.',
};

function localized(table: Record<string, string>, language: string): string {
  return Object.prototype.hasOwnProperty.call(table, language) ? table[language] : table.en;
}

/** Appended after the {{context}} substitution on the chunk-alias path. */
export function citationInstruction(language: string): string {
  return localized(CITATION_INSTRUCTIONS, language);
}

/** Takes the place of the context on the Claude Citations path. */
export function attachedDocumentsSentence(_language: string): string {
  return '';
}
