import { splitTableBlocks, tableCells, type MarkdownBlock, type TableBlock } from '../ingest/chunkers/markdown-tables';
import { lexicalTokens } from '../lexical/tokenize';

/** Rows stored per document and chunking profile (one rag_write_table_rows call); later rows are dropped and counted. */
export const MAX_TABLE_ROWS_PER_PROFILE = 1000;
/** Columns kept per table; cells beyond them are dropped and counted. */
export const MAX_TABLE_CELLS_PER_ROW = 32;
/** Characters kept per cell or header name; longer text is cut and counted. */
export const MAX_TABLE_CELL_CHARS = 512;

export interface TableParseChunk {
  id: string;
  documentId: string;
  chunkingProfileId: string;
  chunkIndex: number;
  sectionPath: readonly string[];
  content: string;
}

export interface ParsedTableRow {
  /** `<document id>:t<table ordinal within the profile>` (tableKeyFor). */
  tableKey: string;
  rowIndex: number;
  header: string[];
  /** Header name to cell text, in header order. */
  cells: Record<string, string>;
  /** One lexicalTokens array per cell, in header order. */
  cellTokens: string[][];
  /** The union of the row's cell tokens, first seen first. */
  cellNorm: string[];
  chunkIds: string[];
}

export interface TableTruncation {
  rows: number;
  cells: number;
  chars: number;
}

export interface TableParseResult {
  /** Rows by chunking profile id; a profile without any table row has no entry. */
  profiles: Map<string, { rows: ParsedTableRow[] }>;
  truncated: TableTruncation;
}

export function tableKeyFor(documentId: string, ordinal: number): string {
  return `${documentId}:t${ordinal}`;
}

interface OpenTable {
  key: string;
  header: string[];
  /** The header row as written, to recognise a piece that repeats it. */
  headerLine: string;
  nextRow: number;
  sectionKey: string;
}

interface ProfileState {
  rows: ParsedTableRow[];
  ordinal: number;
  open: OpenTable | null;
  /** True while the previous chunk ended with the open table, so the next chunk may continue it. */
  openAtChunkEnd: boolean;
  lastChunkIndex: number | null;
}

const SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function clip(text: string, truncated: TableTruncation): string {
  if (text.length <= MAX_TABLE_CELL_CHARS) return text;
  truncated.chars += 1;
  return text.slice(0, MAX_TABLE_CELL_CHARS);
}

function cellsOf(line: string): string[] {
  return tableCells(line).map((cell) => cell.replace(/\\\|/g, '|'));
}

/** Header names made unique in a fixed order: a written name keeps its first occurrence, the rest take the next free `_n` suffix. */
export function uniqueHeader(names: readonly string[]): string[] {
  const used = new Set<string>();
  const firsts = new Set<number>();
  names.forEach((name, index) => {
    if (name !== '' && !used.has(name)) {
      used.add(name);
      firsts.add(index);
    }
  });
  return names.map((name, index) => {
    if (firsts.has(index)) return name;
    const base = name === '' ? `column_${index + 1}` : name;
    if (name === '' && !used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}_${n}`)) n += 1;
    used.add(`${base}_${n}`);
    return `${base}_${n}`;
  });
}

function generatedHeader(columns: number): string[] {
  return Array.from({ length: columns }, (_, index) => `column_${index + 1}`);
}

function isBlank(block: MarkdownBlock): boolean {
  return block.kind === 'text' && block.lines.every((line) => line.trim() === '');
}

function headerLineOf(block: TableBlock): string | null {
  return block.header === null ? null : (block.header.split('\n')[0] ?? null);
}

function buildRow(
  table: OpenTable,
  line: string,
  chunkId: string,
  truncated: TableTruncation,
): ParsedTableRow {
  const raw = cellsOf(line);
  if (raw.length > table.header.length) truncated.cells += raw.length - table.header.length;
  const cells: Record<string, string> = {};
  const cellTokens: string[][] = [];
  const norm = new Set<string>();
  table.header.forEach((name, column) => {
    const value = clip(raw[column] ?? '', truncated);
    cells[name] = value;
    const tokens = value === '' ? [] : lexicalTokens(value);
    cellTokens.push(tokens);
    for (const token of tokens) norm.add(token);
  });
  const row: ParsedTableRow = {
    tableKey: table.key,
    rowIndex: table.nextRow,
    header: table.header.slice(),
    cells,
    cellTokens,
    cellNorm: [...norm],
    chunkIds: [chunkId],
  };
  table.nextRow += 1;
  return row;
}

function openTable(state: ProfileState, documentId: string, names: string[], headerLine: string, sectionKey: string, truncated: TableTruncation): OpenTable {
  if (names.length > MAX_TABLE_CELLS_PER_ROW) truncated.cells += names.length - MAX_TABLE_CELLS_PER_ROW;
  const header = uniqueHeader(names.slice(0, MAX_TABLE_CELLS_PER_ROW).map((name) => clip(name, truncated)));
  const table: OpenTable = { key: tableKeyFor(documentId, state.ordinal), header, headerLine, nextRow: 0, sectionKey };
  state.ordinal += 1;
  return table;
}

function parseChunk(state: ProfileState, chunk: TableParseChunk, truncated: TableTruncation): void {
  const sectionKey = JSON.stringify(chunk.sectionPath);
  const blocks = splitTableBlocks(chunk.content.replace(/\r\n?/g, '\n').split('\n'));
  const follows = state.lastChunkIndex !== null && chunk.chunkIndex === state.lastChunkIndex + 1;
  // At the start of a chunk only the open table of the directly preceding chunk can continue; inside a chunk a table never continues another.
  let carry: OpenTable | null = follows && state.openAtChunkEnd ? state.open : null;
  let leading = true;
  let endedWithTable = false;

  for (const block of blocks) {
    if (isBlank(block)) continue;
    if (block.kind === 'text') {
      leading = false;
      carry = null;
      endedWithTable = false;
      continue;
    }
    const headerLine = headerLineOf(block);
    const lines = block.rows.filter((line) => !SEPARATOR_ROW.test(line));
    const columns = cellsOf(headerLine ?? lines[0] ?? '').length;
    let table: OpenTable;
    const candidate = leading ? carry : null;
    const sameSection = candidate !== null && candidate.sectionKey === sectionKey;
    if (candidate && sameSection && headerLine === null && columns === candidate.header.length) {
      table = candidate;
    } else if (candidate && sameSection && headerLine !== null && headerLine.trim() === candidate.headerLine.trim()) {
      table = candidate;
    } else if (headerLine !== null) {
      table = openTable(state, chunk.documentId, cellsOf(headerLine), headerLine, sectionKey, truncated);
    } else {
      table = openTable(state, chunk.documentId, generatedHeader(columns), '', sectionKey, truncated);
    }
    for (const line of lines) {
      if (state.rows.length >= MAX_TABLE_ROWS_PER_PROFILE) {
        truncated.rows += 1;
        continue;
      }
      state.rows.push(buildRow(table, line, chunk.id, truncated));
    }
    state.open = table;
    leading = false;
    carry = null;
    endedWithTable = true;
  }
  state.openAtChunkEnd = endedWithTable;
  state.lastChunkIndex = chunk.chunkIndex;
}

/**
 * Typed rows of every Markdown table in one document's chunks (D-15, D-45): every chunk is parsed, whatever its chunk_kind, per chunking
 * profile in chunk order. A header-less table piece that opens a chunk directly following the chunk whose last block was a table of the
 * same section, with the same column count, continues that table (same table_key, its header); a piece repeating that header continues it
 * too (research F-7). Pure and bounded by the MAX_TABLE_* caps.
 */
export function parseTableRows(chunks: readonly TableParseChunk[]): TableParseResult {
  const truncated: TableTruncation = { rows: 0, cells: 0, chars: 0 };
  const byProfile = new Map<string, TableParseChunk[]>();
  for (const chunk of chunks) {
    const list = byProfile.get(chunk.chunkingProfileId) ?? [];
    list.push(chunk);
    byProfile.set(chunk.chunkingProfileId, list);
  }
  const profiles = new Map<string, { rows: ParsedTableRow[] }>();
  for (const profileId of [...byProfile.keys()].sort()) {
    const list = (byProfile.get(profileId) ?? []).slice().sort((a, b) => a.chunkIndex - b.chunkIndex || a.id.localeCompare(b.id));
    const state: ProfileState = { rows: [], ordinal: 0, open: null, openAtChunkEnd: false, lastChunkIndex: null };
    for (const chunk of list) parseChunk(state, chunk, truncated);
    if (state.rows.length > 0) profiles.set(profileId, { rows: state.rows });
  }
  return { profiles, truncated };
}
