import { describe, expect, test } from 'vitest';
import {
  MAX_TABLE_CELL_CHARS,
  MAX_TABLE_CELLS_PER_ROW,
  MAX_TABLE_ROWS_PER_PROFILE,
  parseTableRows,
  tableKeyFor,
  type TableParseChunk,
} from '@/lib/rag/tables/parse';
import { lexicalTokens } from '@/lib/rag/lexical/tokenize';

const DOC = '0d000000-0000-4000-8000-000000000001';

let sequence = 0;
function chunk(content: string, over: Partial<TableParseChunk> = {}): TableParseChunk {
  sequence += 1;
  return {
    id: `0c000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`,
    documentId: DOC,
    chunkingProfileId: 'legacy',
    chunkIndex: sequence,
    sectionPath: ['Zorvat'],
    content,
    ...over,
  };
}

const TABLE = ['| Kelmo | Darvi | Quenta |', '| --- | --- | --- |', '| plin 41 | rosk | 7 |', '| vatu 52 | mepra | 9 |'].join('\n');

describe('parseTableRows (D-15, D-45, research F-7)', () => {
  test('a paragraph followed by a three-column table yields its rows; chunk_kind is not a filter', () => {
    const c = chunk(`Brelo tasku vimen orlat.\n\n${TABLE}`);
    const result = parseTableRows([c]);
    const legacy = result.profiles.get('legacy');
    expect(legacy?.rows).toHaveLength(2);
    const [first, second] = legacy!.rows;
    expect(first).toMatchObject({
      tableKey: tableKeyFor(DOC, 0),
      rowIndex: 0,
      header: ['Kelmo', 'Darvi', 'Quenta'],
      cells: { Kelmo: 'plin 41', Darvi: 'rosk', Quenta: '7' },
      chunkIds: [c.id],
    });
    expect(first!.cellTokens).toEqual([lexicalTokens('plin 41'), lexicalTokens('rosk'), lexicalTokens('7')]);
    expect(new Set(first!.cellNorm)).toEqual(new Set([...lexicalTokens('plin 41'), ...lexicalTokens('rosk'), ...lexicalTokens('7')]));
    expect(first!.cellNorm.length).toBe(new Set(first!.cellNorm).size);
    expect(second).toMatchObject({ rowIndex: 1, cells: { Kelmo: 'vatu 52', Darvi: 'mepra', Quenta: '9' } });
    expect(result.truncated).toEqual({ rows: 0, cells: 0, chars: 0 });
  });

  test('table_key is the document id and the table ordinal within the profile', () => {
    expect(tableKeyFor(DOC, 3)).toBe(`${DOC}:t3`);
    const two = chunk(`${TABLE}\n\nSorvi plaku.\n\n| Ama | Bero |\n| --- | --- |\n| x1 | y1 |`);
    const rows = parseTableRows([two]).profiles.get('legacy')!.rows;
    expect(rows.map((row) => row.tableKey)).toEqual([tableKeyFor(DOC, 0), tableKeyFor(DOC, 0), tableKeyFor(DOC, 1)]);
    expect(rows[2]).toMatchObject({ rowIndex: 0, header: ['Ama', 'Bero'] });
  });

  test('a header-less continuation in the next chunk of the same section takes the header and the table key', () => {
    const a = chunk(TABLE);
    const b = chunk('| tiro 63 | salvo | 11 |\n| kemu 74 | dorra | 13 |');
    const rows = parseTableRows([a, b]).profiles.get('legacy')!.rows;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.tableKey))).toEqual(new Set([tableKeyFor(DOC, 0)]));
    expect(rows.map((row) => row.rowIndex)).toEqual([0, 1, 2, 3]);
    expect(rows[2]).toMatchObject({ header: ['Kelmo', 'Darvi', 'Quenta'], cells: { Kelmo: 'tiro 63', Darvi: 'salvo', Quenta: '11' }, chunkIds: [b.id] });
  });

  test('a piece that repeats the header in the next chunk continues the same table', () => {
    const a = chunk(TABLE);
    const b = chunk(['| Kelmo | Darvi | Quenta |', '| --- | --- | --- |', '| tiro 63 | salvo | 11 |'].join('\n'));
    const rows = parseTableRows([a, b]).profiles.get('legacy')!.rows;
    expect(rows.map((row) => [row.tableKey, row.rowIndex])).toEqual([
      [tableKeyFor(DOC, 0), 0],
      [tableKeyFor(DOC, 0), 1],
      [tableKeyFor(DOC, 0), 2],
    ]);
  });

  test('a continuation with a different column count starts a new table with generated column names', () => {
    const a = chunk(TABLE);
    const b = chunk('| tiro 63 | salvo |\n| kemu 74 | dorra |');
    const rows = parseTableRows([a, b]).profiles.get('legacy')!.rows;
    expect(rows[2]).toMatchObject({ tableKey: tableKeyFor(DOC, 1), rowIndex: 0, header: ['column_1', 'column_2'], cells: { column_1: 'tiro 63', column_2: 'salvo' } });
  });

  test('a header-less piece in another section, or after text, is not a continuation', () => {
    const a = chunk(TABLE);
    const other = chunk('| tiro 63 | salvo | 11 |', { sectionPath: ['Pemla'] });
    const afterText = chunk('Vorsa minka.\n\n| kemu 74 | dorra | 13 |');
    const rows = parseTableRows([a, other, afterText]).profiles.get('legacy')!.rows;
    expect(rows[2]).toMatchObject({ tableKey: tableKeyFor(DOC, 1), header: ['column_1', 'column_2', 'column_3'] });
    expect(rows[3]).toMatchObject({ tableKey: tableKeyFor(DOC, 2), header: ['column_1', 'column_2', 'column_3'] });
  });

  test('a piece that does not directly follow (a chunk in between) is not a continuation', () => {
    const a = chunk(TABLE);
    const gap = chunk('Vorsa minka tolde.');
    const b = chunk('| tiro 63 | salvo | 11 |');
    const rows = parseTableRows([a, gap, b]).profiles.get('legacy')!.rows;
    expect(rows[2]?.tableKey).toBe(tableKeyFor(DOC, 1));
  });

  test('chunks arrive in any order and are parsed in chunk order', () => {
    const a = chunk(TABLE);
    const b = chunk('| tiro 63 | salvo | 11 |');
    const rows = parseTableRows([b, a]).profiles.get('legacy')!.rows;
    expect(rows.map((row) => row.cells.Kelmo)).toEqual(['plin 41', 'vatu 52', 'tiro 63']);
  });

  test('duplicate and empty header names are disambiguated deterministically; empty cells stay empty with no tokens', () => {
    const c = chunk(['| Lomi | Lomi |  | column_3 |', '| --- | --- | --- | --- |', '| a1 |  | c3 | d4 |'].join('\n'));
    const [row] = parseTableRows([c]).profiles.get('legacy')!.rows;
    expect(row!.header).toEqual(['Lomi', 'Lomi_2', 'column_3_2', 'column_3']);
    expect(row!.cells).toEqual({ Lomi: 'a1', Lomi_2: '', column_3_2: 'c3', column_3: 'd4' });
    expect(row!.cellTokens[1]).toEqual([]);
  });

  test('short rows are padded with empty cells; an escaped pipe stays inside its cell', () => {
    const c = chunk(['| Ama | Bero | Cuvo |', '| --- | --- | --- |', '| x1 \\| x2 | y1 |'].join('\n'));
    const [row] = parseTableRows([c]).profiles.get('legacy')!.rows;
    expect(row!.cells).toEqual({ Ama: 'x1 | x2', Bero: 'y1', Cuvo: '' });
  });

  test('a pipe inside a fenced code block is not a table', () => {
    const c = chunk(['```', '| Ama | Bero |', '| --- | --- |', '| x1 | y1 |', '```'].join('\n'));
    expect(parseTableRows([c]).profiles.get('legacy')?.rows ?? []).toEqual([]);
  });

  test('a chunk without a table yields no profile entry', () => {
    expect(parseTableRows([chunk('Vorsa minka tolde.')]).profiles.size).toBe(0);
  });

  test('rows are keyed by chunking profile, each with its own table ordinals', () => {
    const legacy = chunk(TABLE);
    const child = chunk(TABLE, { chunkingProfileId: 'profile-x' });
    const result = parseTableRows([legacy, child]);
    expect([...result.profiles.keys()].sort()).toEqual(['legacy', 'profile-x']);
    expect(result.profiles.get('profile-x')!.rows.map((row) => [row.tableKey, row.chunkIds])).toEqual([
      [tableKeyFor(DOC, 0), [child.id]],
      [tableKeyFor(DOC, 0), [child.id]],
    ]);
  });

  test('caps: rows per profile, cells per row and characters per cell are bounded and counted', () => {
    const wide = Array.from({ length: MAX_TABLE_CELLS_PER_ROW + 3 }, (_, i) => `h${i}`);
    const header = `| ${wide.join(' | ')} |\n|${wide.map(() => ' --- ').join('|')}|`;
    const long = 'q'.repeat(MAX_TABLE_CELL_CHARS + 10);
    const rowLine = (i: number): string => `| ${[i === 0 ? long : `v${i}`, ...wide.slice(1).map((_, j) => `w${j}`)].join(' | ')} |`;
    const lines = [header, ...Array.from({ length: MAX_TABLE_ROWS_PER_PROFILE + 5 }, (_, i) => rowLine(i))];
    const result = parseTableRows([chunk(lines.join('\n'))]);
    const rows = result.profiles.get('legacy')!.rows;
    expect(rows).toHaveLength(MAX_TABLE_ROWS_PER_PROFILE);
    expect(rows[0]!.header).toHaveLength(MAX_TABLE_CELLS_PER_ROW);
    expect(Object.keys(rows[0]!.cells)).toHaveLength(MAX_TABLE_CELLS_PER_ROW);
    expect(rows[0]!.cells.h0).toHaveLength(MAX_TABLE_CELL_CHARS);
    expect(result.truncated.rows).toBe(5);
    expect(result.truncated.cells).toBeGreaterThanOrEqual(3 * MAX_TABLE_ROWS_PER_PROFILE);
    expect(result.truncated.chars).toBe(1);
  });
});
