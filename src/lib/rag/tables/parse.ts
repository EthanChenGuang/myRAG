export const MAX_TABLE_ROWS_PER_PROFILE = 1000;
export const MAX_TABLE_CELLS_PER_ROW = 32;
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
  tableKey: string;
  rowIndex: number;
  header: string[];
  cells: Record<string, string>;
  cellTokens: string[][];
  cellNorm: string[];
  chunkIds: string[];
}

export interface TableTruncation {
  rows: number;
  cells: number;
  chars: number;
}

export interface TableParseResult {
  profiles: Map<string, { rows: ParsedTableRow[] }>;
  truncated: TableTruncation;
}

export function tableKeyFor(_documentId: string, _ordinal: number): string {
  return '';
}

export function parseTableRows(_chunks: readonly TableParseChunk[]): TableParseResult {
  return { profiles: new Map(), truncated: { rows: 0, cells: 0, chars: 0 } };
}
