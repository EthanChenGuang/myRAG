import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkDocument, type ChunkerConfig } from '@/lib/rag/ingest/chunkers';
import { carryTableHeaders, isHeaderLike } from '@/lib/rag/ingest/chunkers/markdown-tables';
import { chunkParentChild } from '@/lib/rag/ingest/chunkers/parent-child';
import { buildProfileChunks, type ChunkingProfileRow } from '@/lib/rag/ingest/profile-chunks';
import { chunkStage } from '@/lib/rag/ingest/stages/chunk';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import type { ChunkDraft, StageContext } from '@/lib/rag/ingest/types';
import { PROCESSING_PROFILES, profileModeDigests } from './helpers/table-header-snapshot';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ROOT, 'eval/fixtures/ingest');

interface LongTableSpec {
  header: string[];
  value_columns: string[];
  target_row: number;
  target_values: string[];
  continued: boolean;
  tables: Array<{ body_rows: number; header_row: boolean }>;
}

interface LongTableFixture {
  id: string;
  language: string;
  markdown: string;
  spec: LongTableSpec;
}

const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
  long_table_fixtures: Array<{ id: string; language: string; text: { path: string }; expected: { long_table: LongTableSpec } }>;
};

const FIXTURES: LongTableFixture[] = manifest.long_table_fixtures.map((entry) => ({
  id: entry.id,
  language: entry.language,
  markdown: fs.readFileSync(path.join(FIXTURE_DIR, entry.text.path), 'utf8'),
  spec: entry.expected.long_table,
}));
const PLAIN = FIXTURES.filter((fixture) => !fixture.spec.continued);
const CONTINUED = FIXTURES.filter((fixture) => fixture.spec.continued);

const SNAPSHOT = (JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/rag/table-header-profile-snapshot.json'), 'utf8')) as { digests: Record<string, string> })
  .digests;

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
const isPipe = (line: string): boolean => line.trim().startsWith('|');
const isSeparatorLine = (line: string): boolean => isPipe(line) && cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));

/** The header and separator line of the fixture's first table, and its data rows in source order (both tables of a continued fixture). */
function tableOf(fixture: LongTableFixture): { header: string; separator: string; rows: string[]; secondRows: string[] } {
  const lines = fixture.markdown.split('\n');
  const start = lines.findIndex((line, index) => isPipe(line) && isSeparatorLine(lines[index + 1] ?? ''));
  const header = lines[start] ?? '';
  const separator = lines[start + 1] ?? '';
  const rows: string[] = [];
  const secondRows: string[] = [];
  let table = 0;
  let previousPipe = true;
  for (const line of lines.slice(start + 2)) {
    if (!isPipe(line)) {
      previousPipe = false;
      continue;
    }
    if (!previousPipe) table += 1;
    previousPipe = true;
    if (isSeparatorLine(line)) continue;
    rows.push(line);
    if (table > 0) secondRows.push(line);
  }
  return { header, separator, rows, secondRows };
}

/** Every run of table lines in a chunk starts with the header and separator; returns the data lines of the chunk in order. */
function assertHeadedGroups(content: string, header: string, separator: string): string[] {
  const data: string[] = [];
  let group: string[] = [];
  const close = (): void => {
    if (group.length === 0) return;
    expect(group[0]).toBe(header);
    expect(group[1]).toBe(separator);
    for (const line of group.slice(2)) {
      expect(line).not.toBe(header);
      expect(isSeparatorLine(line)).toBe(false);
      data.push(line);
    }
    group = [];
  };
  for (const line of content.split('\n')) {
    if (isPipe(line)) group.push(line);
    else close();
  }
  close();
  return data;
}

/** The rows in order of first appearance equal the source rows, and each chunk holds a contiguous run of them (overlap may repeat a row). */
function assertRowsInOrder(perChunk: string[][], rows: string[]): void {
  const firstSeen: string[] = [];
  const seen = new Set<string>();
  for (const list of perChunk) {
    const indexes = list.map((row) => rows.indexOf(row));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    for (let k = 1; k < indexes.length; k += 1) expect(indexes[k]).toBe((indexes[k - 1] ?? 0) + 1);
    for (const row of list) {
      if (seen.has(row)) continue;
      seen.add(row);
      firstSeen.push(row);
    }
  }
  expect(firstSeen).toEqual(rows);
}

const tableChunks = <T extends Pick<ChunkDraft, 'content'>>(chunks: readonly T[]): T[] => chunks.filter((chunk) => chunk.content.split('\n').some(isPipe));

const targetLine = (fixture: LongTableFixture, rows: string[]): string => {
  const line = rows.find((row) => JSON.stringify(cells(row)) === JSON.stringify(fixture.spec.target_values));
  if (!line) throw new Error(`target row of ${fixture.id} not found`);
  return line;
};

const PROFILE_ROW = (parentMode: ChunkingProfileRow['parentMode']): ChunkingProfileRow => ({
  id: 'p',
  docType: 'general',
  status: 'active',
  childTokens: 96,
  parentMode,
  parentTokens: parentMode === 'none' ? null : 320,
});

describe('RAG_TABLE_HEADER_REPEAT=always on the long-table fixtures (D-19)', () => {
  it('has six processing profiles and three plain and three continued long-table fixtures', () => {
    expect(PROCESSING_PROFILES).toHaveLength(6);
    expect(PLAIN.map((fixture) => fixture.language).sort()).toEqual(['en', 'it', 'zh']);
    expect(CONTINUED.map((fixture) => fixture.language).sort()).toEqual(['en', 'it', 'zh']);
  });

  for (const profile of PROCESSING_PROFILES) {
    for (const fixture of PLAIN) {
      it(`${profile.id} / ${fixture.id}: every table chunk starts with the header, rows keep source order, the target row sits under the value columns`, () => {
        const { header, separator, rows } = tableOf(fixture);
        expect(cells(header)).toEqual(fixture.spec.header);
        expect(rows).toHaveLength(fixture.spec.tables.reduce((sum, table) => sum + table.body_rows, 0));
        const { chunks } = chunkDocument(profile.chunker, { markdown: fixture.markdown }, { tableHeaderRepeat: 'always' });
        const withTable = tableChunks(chunks);
        expect(withTable.length).toBeGreaterThan(1);
        const perChunk = withTable.map((chunk) => assertHeadedGroups(chunk.content, header, separator));
        assertRowsInOrder(perChunk, rows);
        for (const chunk of withTable) {
          if (chunk.chunk_kind === 'table') expect(chunk.content.startsWith(`${header}\n${separator}\n`)).toBe(true);
        }
        const target = targetLine(fixture, rows);
        const holding = withTable.filter((chunk) => chunk.content.split('\n').includes(target));
        expect(holding.length).toBeGreaterThan(0);
        for (const chunk of holding) for (const column of fixture.spec.value_columns) expect(chunk.content).toContain(column);
      });
    }
  }

  for (const fixture of PLAIN) {
    for (const parentMode of ['none', 'structure', 'fixed'] as const) {
      it(`rag:rechunk path (buildProfileChunks, ${parentMode}) / ${fixture.id}: every child with table rows starts with the header`, () => {
        const { header, separator, rows } = tableOf(fixture);
        for (const profile of PROCESSING_PROFILES) {
          const built = buildProfileChunks(
            { filename: `${fixture.id}.md`, chunker: profile.chunker, tableHeaderRepeat: 'always' },
            fixture.markdown,
            PROFILE_ROW(parentMode),
          );
          const children = tableChunks(built.children);
          expect(children.length).toBeGreaterThan(1);
          assertRowsInOrder(children.map((child) => assertHeadedGroups(child.content, header, separator)), rows);
        }
      });
    }
  }

  it('the legacy structure branch of chunkParentChild takes the forced flag for its parents', () => {
    const fixture = PLAIN.find((entry) => entry.language === 'en') as LongTableFixture;
    const { header, separator } = tableOf(fixture);
    const general = PROCESSING_PROFILES.find((profile) => profile.chunker.repeat_table_header === false && profile.chunker.kind === 'markdown_sections');
    expect(general).toBeDefined();
    const chunker = { ...general!.chunker, repeat_table_header: true };
    const result = chunkParentChild(fixture.markdown, { childTokens: 96, parentMode: 'structure', parentTokens: 320 }, chunker);
    const parents = result.parents.filter((parent) => parent.content.split('\n').some(isPipe));
    expect(parents.length).toBeGreaterThan(1);
    for (const parent of parents) assertHeadedGroups(parent.content, header, separator);
  });

  it('profile mode (and the option absent) is byte-identical to the snapshot taken before the change, for all six profiles', () => {
    const digests = profileModeDigests();
    expect(Object.keys(digests).sort()).toEqual(Object.keys(SNAPSHOT).sort());
    const changed = Object.keys(SNAPSHOT).filter((key) => digests[key] !== SNAPSHOT[key]);
    expect(changed).toEqual([]);
  }, 120_000);
});

const carriedFlag = (chunk: Pick<ChunkDraft, 'metadata'>): unknown => chunk.metadata.table_header_carried;

/** Chunks holding a row of the second table carry the flag; chunks holding only first-table rows do not. */
function assertCarryFlags<T extends Pick<ChunkDraft, 'content' | 'metadata'>>(chunks: readonly T[], secondRows: readonly string[]): void {
  const second = new Set(secondRows);
  let carried = 0;
  for (const chunk of tableChunks(chunks)) {
    if (chunk.content.split('\n').some((line) => second.has(line))) {
      expect(carriedFlag(chunk)).toBe(true);
      carried += 1;
    } else {
      expect(carriedFlag(chunk)).toBeUndefined();
    }
  }
  expect(carried).toBeGreaterThan(0);
}

describe('carry-forward of a header onto a header-less continuation table (D-20)', () => {
  for (const profile of PROCESSING_PROFILES) {
    for (const fixture of CONTINUED) {
      it(`${profile.id} / ${fixture.id}: the second table's chunks start with the first table's header and are marked carried`, () => {
        const { header, separator, rows, secondRows } = tableOf(fixture);
        expect(rows).toHaveLength(fixture.spec.tables.reduce((sum, table) => sum + table.body_rows, 0));
        expect(secondRows).toHaveLength(fixture.spec.tables[1]?.body_rows ?? -1);
        const { chunks } = chunkDocument(profile.chunker, { markdown: fixture.markdown }, { tableHeaderRepeat: 'always' });
        const withTable = tableChunks(chunks);
        assertRowsInOrder(withTable.map((chunk) => assertHeadedGroups(chunk.content, header, separator)), rows);
        assertCarryFlags(chunks, secondRows);
        const target = targetLine(fixture, rows);
        expect(secondRows).toContain(target);
        for (const chunk of withTable.filter((entry) => entry.content.split('\n').includes(target))) {
          for (const column of fixture.spec.value_columns) expect(chunk.content).toContain(column);
        }
      });

      it(`${profile.id} / ${fixture.id}: profile mode carries nothing`, () => {
        const { chunks } = chunkDocument(profile.chunker, { markdown: fixture.markdown }, { tableHeaderRepeat: 'profile' });
        for (const chunk of chunks) expect(carriedFlag(chunk)).toBeUndefined();
      });
    }
  }

  for (const fixture of CONTINUED) {
    it(`rag:rechunk path (buildProfileChunks) / ${fixture.id}: children of the second table start with the carried header and are marked`, () => {
      const { header, separator, rows, secondRows } = tableOf(fixture);
      for (const profile of PROCESSING_PROFILES) {
        for (const parentMode of ['none', 'structure', 'fixed'] as const) {
          const built = buildProfileChunks(
            { filename: `${fixture.id}.md`, chunker: profile.chunker, tableHeaderRepeat: 'always' },
            fixture.markdown,
            PROFILE_ROW(parentMode),
          );
          assertRowsInOrder(tableChunks(built.children).map((child) => assertHeadedGroups(child.content, header, separator)), rows);
          assertCarryFlags(built.children, secondRows);
        }
      }
    });

    it(`ingest chunk stage / ${fixture.id}: the stage reads RAG_TABLE_HEADER_REPEAT from the ingest config`, async () => {
      const { header, separator, secondRows } = tableOf(fixture);
      const general = PROCESSING_PROFILES.find((profile) => profile.chunker.kind === 'markdown_sections') as (typeof PROCESSING_PROFILES)[number];
      const run = async (tableHeaderRepeat: 'profile' | 'always'): Promise<ChunkDraft[]> => {
        const ctx = {
          identity: { filename: `${fixture.id}.md`, profile: { chunker: general.chunker } },
          config: { languageAwareIngest: 'off', tableHeaderRepeat },
          work: { parseText: fixture.markdown, parseChunks: null, parserVersion: null, chunks: [], chunksWritten: 0 },
          warnings: [],
        } as unknown as StageContext;
        expect((await chunkStage.run(ctx)).kind).toBe('next');
        return ctx.work.chunks;
      };
      const forced = await run('always');
      for (const chunk of tableChunks(forced)) assertHeadedGroups(chunk.content, header, separator);
      assertCarryFlags(forced, secondRows);
      for (const chunk of await run('profile')) expect(carriedFlag(chunk)).toBeUndefined();
    });
  }
});

const H = '| Label | Group | Count | Total |';
const SEP = '| --- | --- | --- | --- |';
const row = (i: number): string => `| Item ${i} | Group ${i % 3} | ${10 + i} | ${200 + i} |`;
const rowsOf = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, k) => row(from + k));

describe('carryTableHeaders: the Markdown continuation rule', () => {
  it('rules: a header row is header-like, a data row is not', () => {
    expect(isHeaderLike(H, rowsOf(0, 6))).toBe(true);
    expect(isHeaderLike(row(6), rowsOf(0, 6))).toBe(false);
  });

  it('a table that follows across blank lines with the same column count and a data-like first row takes the previous header', () => {
    const markdown = ['Intro sentence.', '', H, SEP, ...rowsOf(0, 6), '', '', row(6), SEP, ...rowsOf(7, 10), '', 'Closing sentence.'].join('\n');
    const result = carryTableHeaders(markdown);
    expect(result.carried).toBe(1);
    expect(result.markdown).toBe(['Intro sentence.', '', H, SEP, ...rowsOf(0, 6), '', '', H, SEP, ...rowsOf(6, 10), '', 'Closing sentence.'].join('\n'));
    expect([...result.carriedRows]).toEqual(rowsOf(6, 10));
  });

  it('a header-less pipe run after a table takes the header and keeps every row', () => {
    const markdown = [H, SEP, ...rowsOf(0, 4), '', ...rowsOf(4, 8)].join('\n');
    const result = carryTableHeaders(markdown);
    expect(result.carried).toBe(1);
    expect(result.markdown).toBe([H, SEP, ...rowsOf(0, 4), '', H, SEP, ...rowsOf(4, 8)].join('\n'));
  });

  it('a chain of continuations all take the first header', () => {
    const markdown = [H, SEP, ...rowsOf(0, 4), '', row(4), SEP, ...rowsOf(5, 8), '', row(8), SEP, ...rowsOf(9, 12)].join('\n');
    const result = carryTableHeaders(markdown);
    expect(result.carried).toBe(2);
    expect(result.markdown).toBe([H, SEP, ...rowsOf(0, 4), '', H, SEP, ...rowsOf(4, 8), '', H, SEP, ...rowsOf(8, 12)].join('\n'));
  });

  const untouched: Array<[string, string[]]> = [
    ['a second table with its own header-like first row', [H, SEP, ...rowsOf(0, 6), '', '| Name | Kind | Size | Weight |', SEP, ...rowsOf(6, 9)]],
    ['a second table with a different column count', [H, SEP, ...rowsOf(0, 6), '', '| Item 6 | Group 0 | 16 |', '| --- | --- | --- |', '| Item 7 | Group 1 | 17 |']],
    ['two tables separated by a paragraph', [H, SEP, ...rowsOf(0, 6), '', 'A plain sentence between the two tables.', '', row(6), SEP, ...rowsOf(7, 9)]],
    ['a header-less table with no table before it', ['Intro sentence.', '', ...rowsOf(0, 4)]],
    ['a header-less first table followed by a continuation', [...rowsOf(0, 4), '', row(4), SEP, ...rowsOf(5, 7)]],
    ['a continuation candidate inside a code fence', [H, SEP, ...rowsOf(0, 4), '', '```', row(4), SEP, '```']],
  ];
  for (const [name, lines] of untouched) {
    it(`leaves ${name} untouched and marks nothing`, () => {
      const markdown = lines.join('\n');
      const result = carryTableHeaders(markdown);
      expect(result.carried).toBe(0);
      expect(result.markdown).toBe(markdown);
      expect(result.carriedRows.size).toBe(0);
      for (const profile of PROCESSING_PROFILES) {
        const { chunks } = chunkDocument(profile.chunker, { markdown: `## Section\n\n${markdown}\n` }, { tableHeaderRepeat: 'always' });
        for (const chunk of chunks) expect(carriedFlag(chunk)).toBeUndefined();
      }
    });
  }
});

describe('header repetition edge cases under always (CHK-06)', () => {
  const tableAware = (maxTokens: number): ChunkerConfig => ({
    kind: 'table_aware',
    max_tokens: maxTokens,
    overlap_tokens: 0,
    repeat_table_header: false,
    min_chunk_tokens: 0,
    clause_patterns: [],
    lead_in_phrases: [],
  });
  const tokensOf = (content: string): number => countTokens(buildEmbeddingText({ section_path: ['Section'], content }));

  it('rows that exactly fill the budget stay one chunk with one header; one more row starts a second chunk with the header', () => {
    const table = [H, SEP, ...rowsOf(0, 12)].join('\n');
    const budget = tokensOf(table);
    const exact = chunkDocument(tableAware(budget), { markdown: `## Section\n\n${table}\n` }, { tableHeaderRepeat: 'always' }).chunks;
    expect(exact.map((chunk) => chunk.content)).toEqual([table]);

    const longer = [H, SEP, ...rowsOf(0, 13)].join('\n');
    const split = chunkDocument(tableAware(budget), { markdown: `## Section\n\n${longer}\n` }, { tableHeaderRepeat: 'always' }).chunks;
    expect(split).toHaveLength(2);
    for (const chunk of split) expect(chunk.content.startsWith(`${H}\n${SEP}\n`)).toBe(true);
    expect(split.flatMap((chunk) => chunk.content.split('\n').slice(2))).toEqual(rowsOf(0, 13));
  });

  it('a header-only table yields one chunk without a repeated header', () => {
    for (const profile of PROCESSING_PROFILES) {
      const { chunks } = chunkDocument(profile.chunker, { markdown: `## Section\n\n${H}\n${SEP}\n` }, { tableHeaderRepeat: 'always' });
      expect(chunks.map((chunk) => chunk.content)).toEqual([`${H}\n${SEP}`]);
    }
  });

  it('two adjacent tables with the same column count, the second with its own header, are not merged', () => {
    const other = '| Name | Kind | Size | Weight |';
    const markdown = `## Section\n\n${[H, SEP, ...rowsOf(0, 20), '', other, SEP, ...rowsOf(20, 40)].join('\n')}\n`;
    const { chunks } = chunkDocument(tableAware(120), { markdown }, { tableHeaderRepeat: 'always' });
    const second = new Set(rowsOf(20, 40));
    for (const chunk of chunks) {
      expect(carriedFlag(chunk)).toBeUndefined();
      if (chunk.content.split('\n').some((line) => second.has(line))) expect(chunk.content.startsWith(`${other}\n${SEP}\n`)).toBe(true);
      else expect(chunk.content.startsWith(`${H}\n${SEP}\n`)).toBe(true);
    }
  });
});

describe('Docling chunks that took a carried header in the sidecar (D-20, 03.2-28)', () => {
  const docling: ChunkerConfig = PROCESSING_PROFILES.find((profile) => profile.chunker.kind === 'table_aware')!.chunker;
  const chunk = (carried?: boolean) => ({
    text: '| Item | Value |\n|---|---|\n| Item 01 | 4.5 |',
    contextualized_text: '| Item | Value |\n|---|---|\n| Item 01 | 4.5 |',
    headings: [],
    pages: [2],
    is_table: true,
    table_header: '| Item | Value |\n|---|---|',
    ...(carried === undefined ? {} : { table_header_carried: carried }),
  });

  it('records metadata.table_header_carried on a sidecar chunk that reports it', () => {
    const { chunks } = chunkDocument(docling, { markdown: 'unused', chunks: [chunk(true)] });
    expect(chunks.map((draft) => draft.metadata)).toEqual([{ table_header_carried: true }]);
  });

  it('leaves the metadata empty on a sidecar chunk without the field, as before', () => {
    const { chunks } = chunkDocument(docling, { markdown: 'unused', chunks: [chunk()] });
    expect(chunks.map((draft) => draft.metadata)).toEqual([{}]);
  });
});
