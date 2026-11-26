import { getLanguagePack } from '../../lang/registry';
import { splitTableBlocks } from '../chunkers/markdown-tables';

/**
 * Added to the embedding-text version while RAG_TABLE_ROW_SERIALIZATION is on (D-21). The template version lives in
 * processing-profiles.json, which is not edited for this switch, so the effective version is derived here (research Pitfall 12).
 */
export const ROW_SERIALIZATION_VERSION_SUFFIX = 1000;

const FALLBACK_LANGUAGE = 'en';
const FALLBACK_SEPARATOR = ', ';
const UND = 'und';
const LINE_BREAK_TAG = /<br\s*\/?>/giu;

export function effectiveEmbeddingTextVersion(profileVersion: number, rowSerialization: boolean): number {
  return rowSerialization ? profileVersion + ROW_SERIALIZATION_VERSION_SUFFIX : profileVersion;
}

/** Splits one Markdown table row at unescaped pipes; an escaped pipe stays in the cell as a plain pipe. */
function cellsOf(row: string): string[] {
  let line = row.trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map(cleanCell);
}

/** Verbatim apart from whitespace: line breaks (also as <br>) and runs of spaces become one space, the ends are trimmed. */
function cleanCell(cell: string): string {
  return cell.replace(LINE_BREAK_TAG, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * D-21: one line per data row of every table with a header in the Markdown, `<column>=<value>` for each non-empty cell whose column has a
 * name, joined with the pack's list separator. A row without such a cell gives no line; a table without a header row gives none.
 */
export function serializeTableRows(markdownTable: string, pack: { list_separator: string }): string[] {
  const lines: string[] = [];
  for (const block of splitTableBlocks(markdownTable.split('\n'))) {
    if (block.kind !== 'table' || block.header === null) continue;
    const columns = cellsOf(block.header.split('\n')[0] ?? '');
    for (const row of block.rows) {
      const pairs: string[] = [];
      cellsOf(row).forEach((value, index) => {
        const column = columns[index];
        if (column && value !== '') pairs.push(`${column}=${value}`);
      });
      if (pairs.length > 0) lines.push(pairs.join(pack.list_separator));
    }
  }
  return lines;
}

export interface TableRowLanguageInput {
  /** The chunk's own language (RAG_LANGUAGE_AWARE_INGEST=on); otherwise absent or the document's, mirrored. */
  chunkLanguage?: string | null;
  documentLanguage?: string | null;
  primary?: string | null;
}

function known(language: string | null | undefined): language is string {
  return typeof language === 'string' && language !== '' && language !== UND;
}

/** The block's language: the chunk's own, else the document's, else the primary language, else en. */
export function tableRowLanguage(input: TableRowLanguageInput): string {
  if (known(input.chunkLanguage)) return input.chunkLanguage;
  if (known(input.documentLanguage)) return input.documentLanguage;
  if (known(input.primary)) return input.primary;
  return FALLBACK_LANGUAGE;
}

/** The list separator for the row lines of a chunk, or null when no lines are written (switch off, or not a table chunk). */
export function tableRowSeparator(enabled: boolean, chunkKind: string | null | undefined, language: string): string | null {
  if (!enabled || chunkKind !== 'table') return null;
  return getLanguagePack(language)?.list_separator ?? getLanguagePack(FALLBACK_LANGUAGE)?.list_separator ?? FALLBACK_SEPARATOR;
}

