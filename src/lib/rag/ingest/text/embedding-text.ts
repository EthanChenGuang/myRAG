export const EMBEDDING_TEXT_VERSION = 0;

export interface EmbeddingTextInput {
  section_path: string[];
  content: string;
  template_header?: string;
}

export type TemplateRow = Record<string, string | number | null | undefined>;

export function buildEmbeddingText(_input: EmbeddingTextInput): string {
  return '';
}

export function renderTemplateHeader(_template: string, _row: TemplateRow): string {
  return '';
}
