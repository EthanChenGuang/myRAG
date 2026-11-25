import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '@/lib/rag/ingest/chunkers';
import { chunkParentChild } from '@/lib/rag/ingest/chunkers/parent-child';
import { buildProfileChunks, type ChunkingProfileRow } from '@/lib/rag/ingest/profile-chunks';
import type { ChunkDraft } from '@/lib/rag/ingest/types';
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
