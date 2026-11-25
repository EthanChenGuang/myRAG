import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { effectiveEmbeddingTextVersion, serializeTableRows, tableRowLanguage, tableRowSeparator } from '@/lib/rag/ingest/text/table-rows';
import { EMBEDDING_TEXT_VERSION } from '@/lib/rag/ingest/text/embedding-text';
import { LEXICAL_VERSION, lexicalTokens } from '@/lib/rag/lexical/chunk-text';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { IngestEnvInput } from '@/lib/rag/ingest/config';
import { callsOf, fakeIngestDb, installIngestDeps, uninstallIngestDeps, unitVector } from '../helpers/ingest-fakes';
import manifest from '../../eval/fixtures/ingest/manifest.json';
import offSnapshot from '../fixtures/ingest/table-row-serialization-off.json';

type Language = 'zh' | 'en' | 'it';
type DocType = 'general' | 'financial_report';

interface LongTableSpec {
  header: string[];
  target_row: number;
  target_values: string[];
  body_rows: number;
}

interface SnapshotChunk {
  chunk_kind: string;
  content: string;
  lexical_text: string;
  embedding_text: string;
  embedding_text_version: number;
}

interface Ingested {
  chunks: Array<{ chunk_kind: string; content: string; lexical_text: string; embedding_text: string; embedding_text_version: number }>;
}

const LANGUAGES: Language[] = ['zh', 'en', 'it'];
const SEPARATOR: Record<Language, string> = { zh: '，', en: ', ', it: ', ' };
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function longTableSpec(language: Language): LongTableSpec {
  const fixtures = (manifest as unknown as { long_table_fixtures: Array<{ id: string; expected: { long_table: LongTableSpec } }> }).long_table_fixtures;
  const fixture = fixtures.find((entry) => entry.id === `long-table-${language}`);
  if (!fixture) throw new Error(`fixture long-table-${language} missing`);
  return fixture.expected.long_table;
}

async function ingestLongTable(language: Language, docType: DocType, env: IngestEnvInput): Promise<Ingested> {
  const { db, calls } = fakeIngestDb();
  const embedded: string[] = [];
  installIngestDeps({
    db,
    env,
    embedDocuments: async (texts) => {
      embedded.push(...texts);
      return texts.map(() => unitVector());
    },
  });
  try {
    const text = fs.readFileSync(`eval/fixtures/ingest/text/long-table-${language}.md`, 'utf8');
    const result = await ingest({
      scope: mintScope('single', null, null),
      source: 'config_upload',
      sourceKey: `root/long-table-${language}.md`,
      text,
      filename: `long-table-${language}.md`,
      mimeType: 'text/markdown',
      docType,
      signal: new AbortController().signal,
    } as Parameters<typeof ingest>[0]);
    expect(result.status).toBe('ready');
    const written = callsOf(calls, 'rag_write_chunks').flatMap((call) => call.args.p_chunks as Array<Record<string, unknown>>);
    expect(embedded).toHaveLength(written.length);
    return {
      chunks: written.map((chunk, index) => ({
        chunk_kind: String(chunk.chunk_kind),
        content: String(chunk.content),
        lexical_text: String(chunk.lexical_text),
        embedding_text: embedded[index] as string,
        embedding_text_version: Number(chunk.embedding_text_version),
      })),
    };
  } finally {
    uninstallIngestDeps();
  }
}

function hashed(ingested: Ingested): SnapshotChunk[] {
  return ingested.chunks.map((chunk) => ({
    chunk_kind: chunk.chunk_kind,
    content: sha(chunk.content),
    lexical_text: sha(chunk.lexical_text),
    embedding_text: sha(chunk.embedding_text),
    embedding_text_version: chunk.embedding_text_version,
  }));
}

function dataRowCount(content: string): number {
  return content.split('\n').filter((line) => line.trim().startsWith('|') && !/^\s*\|?\s*:?-{3,}/.test(line)).length - 1;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

describe('RAG_TABLE_ROW_SERIALIZATION off (D-21): index text is byte-identical to the snapshot taken before the change', () => {
  for (const docType of ['general', 'financial_report'] as const) {
    for (const language of LANGUAGES) {
      test(`${docType} long-table-${language}: unset and false`, async () => {
        const expected = (offSnapshot as Record<string, SnapshotChunk[]>)[`${docType}/${language}`];
        expect(expected?.length).toBeGreaterThan(0);
        for (const env of [{}, { RAG_TABLE_ROW_SERIALIZATION: 'false' }] as IngestEnvInput[]) {
          expect(hashed(await ingestLongTable(language, docType, env))).toEqual(expected);
        }
      });
    }
  }
});

describe('RAG_TABLE_ROW_SERIALIZATION on (D-21, CHK-07)', () => {
  for (const language of LANGUAGES) {
    test(`long-table-${language}: table chunks end with one column=value line per data row; content and text chunks are unchanged`, async () => {
      const spec = longTableSpec(language);
      const off = await ingestLongTable(language, 'financial_report', {});
      const on = await ingestLongTable(language, 'financial_report', { RAG_TABLE_ROW_SERIALIZATION: 'true' });
      expect(on.chunks.map((chunk) => chunk.chunk_kind)).toEqual(off.chunks.map((chunk) => chunk.chunk_kind));
      expect(on.chunks.filter((chunk) => chunk.chunk_kind === 'table').length).toBeGreaterThan(1);

      const allLines: string[] = [];
      on.chunks.forEach((chunk, index) => {
        const before = off.chunks[index]!;
        expect(chunk.content).toBe(before.content);
        if (chunk.chunk_kind !== 'table') {
          expect(chunk.embedding_text).toBe(before.embedding_text);
          expect(chunk.lexical_text).toBe(before.lexical_text);
          expect(chunk.embedding_text_version).toBe(before.embedding_text_version);
          return;
        }
        const rows = dataRowCount(chunk.content);
        expect(rows).toBeGreaterThan(0);
        expect(chunk.embedding_text.startsWith(`${before.embedding_text}\n\n`)).toBe(true);
        const lines = chunk.embedding_text.slice(before.embedding_text.length + 2).split('\n');
        expect(lines).toHaveLength(rows);
        for (const line of lines) {
          expect(line.split(SEPARATOR[language]).map((pair) => pair.split('=')[0])).toEqual(spec.header);
        }
        allLines.push(...lines);
        expect(chunk.lexical_text.startsWith(`${before.lexical_text} `)).toBe(true);
        expect(chunk.lexical_text.slice(before.lexical_text.length + 1)).toBe(lexicalTokens(lines.join('\n')).join(' '));
        expect(chunk.embedding_text_version).toBe(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, true));
      });

      expect(allLines).toHaveLength(spec.body_rows);
      const targetLine = spec.header.map((column, index) => `${column}=${spec.target_values[index]}`).join(SEPARATOR[language]);
      expect(allLines[spec.target_row]).toBe(targetLine);
    });
  }

  test('LEXICAL_VERSION keeps its trunk value; the effective embedding-text version moves only with the switch', () => {
    expect(LEXICAL_VERSION).toBe(2);
    expect(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, false)).toBe(EMBEDDING_TEXT_VERSION);
    expect(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, true)).not.toBe(EMBEDDING_TEXT_VERSION);
    expect(effectiveEmbeddingTextVersion(3, false)).toBe(3);
    expect(effectiveEmbeddingTextVersion(3, true)).not.toBe(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, true));
  });

  test('language-aware ingestion on: the zh table blocks use the zh separator from their own chunk language', async () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'zh,en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    resetLanguageSettingsForTests();
    const on = await ingestLongTable('zh', 'financial_report', { RAG_TABLE_ROW_SERIALIZATION: 'true', RAG_LANGUAGE_AWARE_INGEST: 'on' });
    const tables = on.chunks.filter((chunk) => chunk.chunk_kind === 'table');
    expect(tables.length).toBeGreaterThan(0);
    for (const chunk of tables) expect(chunk.embedding_text.split('\n').at(-1)).toContain('，测量批次=');
  });
});

describe('block language and separator', () => {
  test('chunk language, then document language, then primary, then en; und counts as missing', () => {
    expect(tableRowLanguage({ chunkLanguage: 'it', documentLanguage: 'zh', primary: 'en' })).toBe('it');
    expect(tableRowLanguage({ chunkLanguage: 'und', documentLanguage: 'zh', primary: 'en' })).toBe('zh');
    expect(tableRowLanguage({ chunkLanguage: null, documentLanguage: null, primary: 'zh' })).toBe('zh');
    expect(tableRowLanguage({ chunkLanguage: 'und', documentLanguage: 'und', primary: null })).toBe('en');
    expect(tableRowLanguage({})).toBe('en');
  });

  test('a separator only for table chunks with the switch on, from the pack of the language', () => {
    expect(tableRowSeparator(true, 'table', 'zh')).toBe('，');
    expect(tableRowSeparator(true, 'table', 'en')).toBe(', ');
    expect(tableRowSeparator(true, 'table', 'it')).toBe(', ');
    expect(tableRowSeparator(true, 'table', 'xx')).toBe(', ');
    expect(tableRowSeparator(true, 'text', 'zh')).toBeNull();
    expect(tableRowSeparator(false, 'table', 'zh')).toBeNull();
  });

  test('serializeTableRows reads the header of the block', () => {
    expect(serializeTableRows('| A | B |\n| --- | --- |\n| 1 | 2 |', { list_separator: ', ' })).toEqual(['A=1, B=2']);
  });
});
