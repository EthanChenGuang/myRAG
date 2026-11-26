import { serializeTableRows } from './table-rows';

export const EMBEDDING_TEXT_VERSION = 1;

export interface EmbeddingTextInput {
  section_path: string[];
  content: string;
  template_header?: string;
  /** TPL-05 (D-26): the tenant's stored attribute header; a string, also an empty one, takes the place of template_header. */
  attribute_header?: string | null;
  /** D-21: the list separator of the block's language, set only for a table chunk while RAG_TABLE_ROW_SERIALIZATION is on. */
  table_row_separator?: string | null;
}

export type TemplateRow = Record<string, string | number | null | undefined>;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLACEHOLDER_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The text that gets embedded, rebuilt from stored columns only: section path, optional type header, content, and for a table chunk under
 * RAG_TABLE_ROW_SERIALIZATION one column=value line per data row after it (D-21).
 */
export function buildEmbeddingText(input: EmbeddingTextInput): string {
  const prefix = input.section_path.length > 0 ? `${input.section_path.join(' > ')}\n\n` : '';
  const line = input.attribute_header === undefined || input.attribute_header === null ? input.template_header : input.attribute_header;
  const header = line ? `${line}\n` : '';
  const text = `${prefix}${header}${input.content}`;
  const rows = input.table_row_separator ? serializeTableRows(input.content, { list_separator: input.table_row_separator }) : [];
  return rows.length === 0 ? text : `${text}\n\n${rows.join('\n')}`;
}

/**
 * Renders a profile header template such as "Invoice {invoice_number} | {supplier_name}" from stored document
 * columns. Segments split on "|"; a segment with a missing value is dropped; an unknown placeholder throws.
 */
export function renderTemplateHeader(template: string, row: TemplateRow): string {
  const segments: string[] = [];
  for (const segment of template.split('|')) {
    let missing = false;
    const rendered = segment.replace(PLACEHOLDER, (_whole, name: string) => {
      if (!PLACEHOLDER_NAME.test(name) || !Object.hasOwn(row, name)) {
        throw new Error(`Unknown template placeholder {${name}}`);
      }
      const value = row[name];
      const text = value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
      if (text === '') missing = true;
      return text;
    });
    if (missing) continue;
    const trimmed = rendered.trim();
    if (trimmed !== '') segments.push(trimmed);
  }
  return segments.join(' | ');
}

/**
 * The header line of a profile's embedding_text_template, rendered from the document columns stored for this version. Empty when the
 * profile has no header, no columns were stored (an extraction that failed), or the template names a placeholder the row lacks.
 */
export function templateHeaderFor(template: { header: string | null } | null | undefined, row: TemplateRow | null | undefined): string {
  if (!template?.header || !row) return '';
  try {
    return renderTemplateHeader(template.header, row);
  } catch {
    return '';
  }
}
