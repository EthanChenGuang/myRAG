export interface TableBlock {
  kind: 'table';
  /** Header row and separator row joined by a newline; null for a run of pipe rows without a header. */
  header: string | null;
  rows: string[];
}

export interface TextBlock {
  kind: 'text';
  lines: string[];
}

export type MarkdownBlock = TableBlock | TextBlock;

const FENCE = /^ {0,3}(```|~~~)/;
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const isSeparator = (line: string): boolean => line.includes('|') && SEPARATOR.test(line);
const isRow = (line: string): boolean => line.trim() !== '' && line.includes('|');
const startsWithPipe = (line: string): boolean => line.trim().startsWith('|');

/**
 * Splits the body lines of one section into text blocks and GFM tables. A table is a header row followed by a
 * separator row and the rows after it; a run of lines that start with a pipe but have no separator is a table
 * without a header. Pipes inside a code fence never start a table.
 */
export function splitTableBlocks(lines: readonly string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let text: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (text.length > 0) blocks.push({ kind: 'text', lines: text });
    text = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      text.push(line);
      i += 1;
      continue;
    }
    if (fence !== null) {
      text.push(line);
      i += 1;
      continue;
    }

    const next = lines[i + 1];
    if (line.includes('|') && !isSeparator(line) && next !== undefined && isSeparator(next)) {
      flush();
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i] ?? '')) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'table', header: `${line}\n${next}`, rows });
      continue;
    }
    if (startsWithPipe(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && startsWithPipe(lines[i] ?? '')) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ kind: 'table', header: null, rows });
      continue;
    }
    text.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

export interface TableHeaderRules {
  schema_version: 1;
  rules_version: string;
  numeric_cell_pattern: string;
  min_non_numeric_share: number;
  max_repeated_value_share: number;
}

export interface TableHeaderCarry {
  markdown: string;
  carried: number;
  carriedRows: ReadonlySet<string>;
}

export function isHeaderLike(_row: string, _neighbours: readonly string[]): boolean {
  return true;
}

export function carryTableHeaders(markdown: string): TableHeaderCarry {
  return { markdown, carried: 0, carriedRows: new Set() };
}
