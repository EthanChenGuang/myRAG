export const EMBEDDING_TEXT_VERSION = 1;

export interface EmbeddingTextInput {
  section_path: string[];
  content: string;
  template_header?: string;
}

export type TemplateRow = Record<string, string | number | null | undefined>;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PLACEHOLDER_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The text that gets embedded, rebuilt from stored columns only: section path, optional type header, content.
 */
export function buildEmbeddingText(input: EmbeddingTextInput): string {
  const prefix = input.section_path.length > 0 ? `${input.section_path.join(' > ')}\n\n` : '';
  const header = input.template_header ? `${input.template_header}\n` : '';
  return `${prefix}${header}${input.content}`;
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
