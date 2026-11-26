import rawRules from '../../../../../config/rag/table-header-rules.json';

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
  /** A cell matching this pattern counts as numeric. */
  numeric_cell_pattern: string;
  /** Header-like needs at least this share of non-empty cells that are not numeric. */
  min_non_numeric_share: number;
  /** Header-like allows at most this share of non-empty cells that reappear as a value in the same column of the neighbouring rows. */
  max_repeated_value_share: number;
}

function loadRules(raw: unknown): TableHeaderRules {
  const rules = raw as Partial<TableHeaderRules>;
  const share = (value: unknown): boolean => typeof value === 'number' && value >= 0 && value <= 1;
  if (
    rules.schema_version !== 1 ||
    typeof rules.rules_version !== 'string' ||
    typeof rules.numeric_cell_pattern !== 'string' ||
    !share(rules.min_non_numeric_share) ||
    !share(rules.max_repeated_value_share)
  ) {
    throw new Error('[Ingest] config/rag/table-header-rules.json is invalid');
  }
  return rules as TableHeaderRules;
}

/** D-20 header-likeness thresholds (config/rag/table-header-rules.json, shared with the sidecar). */
export const TABLE_HEADER_RULES: TableHeaderRules = loadRules(rawRules);
const NUMERIC_CELL = new RegExp(TABLE_HEADER_RULES.numeric_cell_pattern, 'u');

/** The trimmed cells of one pipe row; an escaped pipe stays inside its cell. */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * Whether a row reads as a table header: enough of its non-empty cells are not numeric, and few of them reappear as values in the same column
 * of `neighbours` (the rows around it). A row without any non-empty cell counts as header-like, so nothing is carried onto it.
 */
export function isHeaderLike(row: string, neighbours: readonly string[], rules: TableHeaderRules = TABLE_HEADER_RULES): boolean {
  const cells = tableCells(row);
  const filled = cells.map((cell, column) => ({ cell, column })).filter((entry) => entry.cell !== '');
  if (filled.length === 0) return true;
  const numeric = rules === TABLE_HEADER_RULES ? NUMERIC_CELL : new RegExp(rules.numeric_cell_pattern, 'u');
  const columns = neighbours.map(tableCells);
  const nonNumeric = filled.filter((entry) => !numeric.test(entry.cell)).length / filled.length;
  const repeated = filled.filter((entry) => columns.some((other) => other[entry.column] === entry.cell)).length / filled.length;
  return nonNumeric >= rules.min_non_numeric_share && repeated <= rules.max_repeated_value_share;
}

export interface TableHeaderCarry {
  /** The Markdown with every continuation table under its carried header; the input string itself when nothing is carried. */
  markdown: string;
  /** How many continuation tables took a carried header. */
  carried: number;
  /** Data rows of carried tables that occur nowhere else in the document; a chunk holding one received a carried header. */
  carriedRows: ReadonlySet<string>;
}

const blockLines = (block: MarkdownBlock): string[] =>
  block.kind === 'text' ? block.lines : [...(block.header === null ? [] : block.header.split('\n')), ...block.rows];

/**
 * D-20, Markdown path: a table that continues another one without its own header takes the previous table's header. A continuation is a table
 * block that follows a table with a header across blank lines only, has the same column count, and whose first row is not header-like
 * (TABLE_HEADER_RULES, measured against the rows of both tables). Its first row becomes a data row again and its separator row is dropped.
 * A chain of continuations keeps the first header. Everything else, code fences included, is left as it is.
 */
export function carryTableHeaders(markdown: string, rules: TableHeaderRules = TABLE_HEADER_RULES): TableHeaderCarry {
  const blocks = splitTableBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'));
  const out: MarkdownBlock[] = [];
  const carriedBlocks = new Set<TableBlock>();
  let previous: TableBlock | null = null;

  for (const block of blocks) {
    if (block.kind === 'text') {
      if (!block.lines.every((line) => line.trim() === '')) previous = null;
      out.push(block);
      continue;
    }
    const first = block.header === null ? block.rows[0] : block.header.split('\n')[0];
    const rows = block.header === null ? block.rows : [first ?? '', ...block.rows];
    const header = previous?.header ?? null;
    const continues =
      previous !== null &&
      header !== null &&
      first !== undefined &&
      tableCells(first).length === tableCells(header.split('\n')[0] ?? '').length &&
      !isHeaderLike(first, [...previous.rows, ...rows.slice(1)], rules);
    if (continues && header !== null) {
      const carried: TableBlock = { kind: 'table', header, rows };
      carriedBlocks.add(carried);
      out.push(carried);
      previous = carried;
      continue;
    }
    out.push(block);
    previous = block;
  }

  if (carriedBlocks.size === 0) return { markdown, carried: 0, carriedRows: new Set() };

  const counts = new Map<string, number>();
  for (const block of out) for (const line of blockLines(block)) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1);
  const carriedRows = new Set<string>();
  for (const block of carriedBlocks) {
    for (const line of block.rows) if (line.trim() !== '' && counts.get(line.trim()) === 1) carriedRows.add(line.trim());
  }
  return { markdown: out.flatMap(blockLines).join('\n'), carried: carriedBlocks.size, carriedRows };
}

/** Sets metadata.table_header_carried on every draft that holds a row of a carried table (D-20); other drafts are returned as they are. */
export function markCarriedChunks<T extends { content: string; metadata: Record<string, unknown> }>(drafts: T[], carry: TableHeaderCarry): T[] {
  if (carry.carriedRows.size === 0) return drafts;
  return drafts.map((draft) =>
    draft.content.split('\n').some((line) => carry.carriedRows.has(line.trim())) ? { ...draft, metadata: { ...draft.metadata, table_header_carried: true } } : draft,
  );
}
