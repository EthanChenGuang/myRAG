import { fixedText } from '../../lang/texts';
import type { TextsSource } from '../answer-turn';

const CITATION_INSTRUCTIONS: Record<string, string> = {
  en: 'Cite the sources you use with [S<number>] markers taken only from the labelled sources above, for example [S1] or [S1][S3]. Never cite a number that is not in a label.',
  zh: '请使用 [S<编号>] 标记引用你所依据的来源，编号只能取自上方带标签的来源，例如 [S1] 或 [S1][S3]。不要引用标签中不存在的编号。',
  it: 'Cita le fonti che usi con i marcatori [S<numero>] presi solo dalle fonti etichettate qui sopra, per esempio [S1] o [S1][S3]. Non citare mai un numero che non compare in un\'etichetta.',
};

const ATTACHED_DOCUMENTS_SENTENCES: Record<string, string> = {
  en: 'The reference documents for this question are attached to the conversation.',
  zh: '与本问题相关的参考文档已附在对话中。',
  it: 'I documenti di riferimento per questa domanda sono allegati alla conversazione.',
};

function localized(table: Record<string, string>, language: string): string {
  return Object.prototype.hasOwnProperty.call(table, language) ? table[language] : table.en;
}

/** Appended after the {{context}} substitution on the chunk-alias path. */
export function citationInstruction(language: string): string {
  return localized(CITATION_INSTRUCTIONS, language);
}

/** Takes the place of the context on the Claude Citations path. */
export function attachedDocumentsSentence(language: string): string {
  return localized(ATTACHED_DOCUMENTS_SENTENCES, language);
}

/** D-10: citationInstruction by text source; `registry` reads `instructions.citation` from the language registry. */
export function citationInstructionText(language: string, source: TextsSource = 'legacy'): string {
  return source === 'registry' ? fixedText('instructions.citation', language) : citationInstruction(language);
}

/** D-10: attachedDocumentsSentence by text source; `registry` reads `instructions.attached_documents`. */
export function attachedDocumentsText(language: string, source: TextsSource = 'legacy'): string {
  return source === 'registry' ? fixedText('instructions.attached_documents', language) : attachedDocumentsSentence(language);
}
