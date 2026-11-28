import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ingest } from '@/lib/rag/ingest';
import { effectiveEmbeddingTextVersion, serializeTableRows, tableRowLanguage, tableRowSeparator } from '@/lib/rag/ingest/text/table-rows';
import { buildEmbeddingText, EMBEDDING_TEXT_VERSION } from '@/lib/rag/ingest/text/embedding-text';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import { dryRunRelex, runRelex } from '@/lib/rag/ingest/relex/run';
import { enrichStage } from '@/lib/rag/ingest/stages/enrich';
import { toWrites } from '@/lib/rag/ingest/stages/embed-write';
import { emptyIngestState, type ChunkDraft, type StageContext } from '@/lib/rag/ingest/types';
import type { IngestWriter } from '@/lib/rag/ingest/writer';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { LEXICAL_VERSION, chunkLexicalText, lexicalTokens } from '@/lib/rag/lexical/chunk-text';
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
        // The snapshot predates the header-repetition default of 03.2-67 (always), so header repetition is pinned at profile.
        const header = { RAG_TABLE_HEADER_REPEAT: 'profile' };
        for (const env of [header, { ...header, RAG_TABLE_ROW_SERIALIZATION: 'false' }] as IngestEnvInput[]) {
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

describe('serializeTableRows edge cases (CHK-07 empty and encoding)', () => {
  const EN = { list_separator: ', ' };
  const ZH = { list_separator: '，' };

  test('an empty cell produces no pair', () => {
    expect(serializeTableRows('| A | B | C |\n| --- | --- | --- |\n| 1 |  | 3 |', EN)).toEqual(['A=1, C=3']);
  });

  test('a row with only empty cells produces no line', () => {
    expect(serializeTableRows('| A | B |\n| --- | --- |\n|  |   |\n| 5 | 6 |', EN)).toEqual(['A=5, B=6']);
  });

  test('a header-only table chunk produces no line', () => {
    expect(serializeTableRows('| A | B |\n| --- | --- |', EN)).toEqual([]);
    expect(serializeTableRows('Section intro without a table.', EN)).toEqual([]);
  });

  test('a run of pipe rows without a header produces no line', () => {
    expect(serializeTableRows('| 1 | 2 |\n| 3 | 4 |', EN)).toEqual([]);
  });

  test('inner line breaks and repeated spaces in names and values collapse to one space', () => {
    const table = '|  First   column | Second<br>column |\n| --- | --- |\n| one  value<br/>more |   two <br />  parts  |';
    expect(serializeTableRows(table, EN)).toEqual(['First column=one value more, Second column=two parts']);
  });

  test('an equals sign or a separator inside a value is kept as it is', () => {
    expect(serializeTableRows('| Key | Rule |\n| --- | --- |\n| k1 | a=b, c=d |', EN)).toEqual(['Key=k1, Rule=a=b, c=d']);
    expect(serializeTableRows('| 名称 | 说明 |\n| --- | --- |\n| 甲 | 第一，第二 |', ZH)).toEqual(['名称=甲，说明=第一，第二']);
  });

  test('an escaped pipe stays in the value; a cell beyond the header has no column and is left out', () => {
    expect(serializeTableRows('| A | B |\n| --- | --- |\n| x \\| y | z | extra |', EN)).toEqual(['A=x | y, B=z']);
  });

  test('a table whose header was carried to the chunk (plan 27) is serialized with the carried column names', () => {
    const carried = '| Item | Count |\n| --- | --- |\n| row nine | 9 |\n| row ten | 10 |';
    expect(serializeTableRows(carried, EN)).toEqual(['Item=row nine, Count=9', 'Item=row ten, Count=10']);
  });

  test('two tables in one chunk give their lines in source order', () => {
    const two = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\nBetween.\n\n| C |\n| --- |\n| 3 |';
    expect(serializeTableRows(two, EN)).toEqual(['A=1, B=2', 'C=3']);
  });

  test('the lexical text of a table chunk with no row line equals the switch-off text', () => {
    const input = { sectionPath: ['S'], content: '| A | B |\n| --- | --- |', chunkKind: 'table' };
    expect(chunkLexicalText({ ...input, tableRowSeparator: ', ' })).toBe(chunkLexicalText(input));
    expect(buildEmbeddingText({ section_path: ['S'], content: input.content, table_row_separator: ', ' })).toBe(
      buildEmbeddingText({ section_path: ['S'], content: input.content }),
    );
  });
});

describe('enrich: a und table chunk takes the dominant document language (D-13)', () => {
  test('language-aware on: a numbers-only table in a zh document is serialized with the zh separator', async () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'zh,en,it');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    resetLanguageSettingsForTests();
    const zh = '本节说明系统的总体结构以及各个组成部分之间的关系。每个模块都有明确的职责，模块之间通过约定的接口交换数据。数据在进入系统之前会经过校验。';
    const table = '| 1 | 2 |\n| --- | --- |\n| 3 | 4 |';
    const draft = (content: string, kind: 'text' | 'table'): ChunkDraft => ({ content, section_path: [], chunk_kind: kind, page_start: null, page_end: null, metadata: {} });
    const ctx = {
      document: { id: 'doc-1', version: 1, resumed: false },
      identity: { tenantKey: 's:default', filename: 'notes.md', fileSha256: 'x', docType: 'general', docTypeOrigin: 'default', bytes: null },
      config: loadIngestConfig({ RAG_LANGUAGE_AWARE_INGEST: 'on', RAG_TABLE_ROW_SERIALIZATION: 'true' }),
      state: emptyIngestState(),
      work: { parseText: `${zh}\n\n${table}`, parserVersion: null, chunks: [draft(zh, 'text'), draft(table, 'table')], chunksWritten: 0 },
      writer: { setFields: async () => undefined } as unknown as IngestWriter,
    } as unknown as StageContext;
    await enrichStage.run(ctx);
    expect(ctx.work.chunks[1]!.language).toBe('und');
    expect(ctx.work.chunks[1]!.table_row_separator).toBe('，');
    expect(ctx.work.chunks[0]!.table_row_separator).toBeUndefined();
    expect(toWrites(ctx)[1]!.embedding_text_version).toBe(effectiveEmbeddingTextVersion(EMBEDDING_TEXT_VERSION, true));
    expect(toWrites(ctx)[0]!.embedding_text_version).toBe(EMBEDDING_TEXT_VERSION);
    expect(Object.keys(toWrites(ctx)[1]!)).not.toContain('table_row_separator');
  });
});

function recordingRpc(answers: Record<string, (args: Record<string, unknown>) => RpcResponse>): { db: RpcClient; calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const response = answers[fn]?.(args) ?? { data: [], error: null };
      const request: RpcRequest = { abortSignal: () => request, then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected) };
      return request;
    },
  };
  return { db, calls };
}

const TABLE_CONTENT = '| Item | Count |\n| --- | --- |\n| first | 1 |\n| second | 2 |';
const TABLE_ROW = {
  id: '00000000-0000-4000-8000-000000000101',
  tenant_key: 's:default',
  content: TABLE_CONTENT,
  section_path: ['Inventory'],
  chunk_kind: 'table',
  metadata: {},
  language: 'en',
  document_filename: 'inventory.md',
  document_language: 'en',
};
const PLAIN = chunkLexicalText({ sectionPath: ['Inventory'], content: TABLE_CONTENT, chunkKind: 'table', metadata: {}, documentFilename: 'inventory.md' });
const SERIALIZED = chunkLexicalText({ sectionPath: ['Inventory'], content: TABLE_CONTENT, chunkKind: 'table', metadata: {}, documentFilename: 'inventory.md', tableRowSeparator: ', ' });

describe('rag:relex and table row serialization (research Pitfall 12)', () => {
  test('without the option no table pass runs, exactly as before', async () => {
    const { db, calls } = recordingRpc({});
    expect(await runRelex({ db })).toEqual({ updated: 0, batches: 0, tenants: {} });
    expect(calls.map((call) => call.fn)).toEqual(['rag_relex_candidates']);
  });

  test('switch on: a table chunk whose stored lexical text is plain is rewritten with its row lines under the unchanged LEXICAL_VERSION', async () => {
    expect(SERIALIZED).not.toBe(PLAIN);
    const { db, calls } = recordingRpc({
      rag_relex_table_candidates: (args) => ({ data: args.p_after === null ? [{ ...TABLE_ROW, lexical_text: PLAIN }] : [], error: null }),
      rag_relex_batch: () => ({ data: [{ rag_relex_batch: 1 }], error: null }),
    });
    const report = await runRelex({ db, tableRowSerialization: true, tenantKey: 's:default' });
    const batch = callsOf(calls, 'rag_relex_batch');
    expect(batch).toHaveLength(1);
    expect(batch[0]!.args).toEqual({ p_rows: [{ id: TABLE_ROW.id, lexical_text: SERIALIZED }], p_version: LEXICAL_VERSION });
    expect(callsOf(calls, 'rag_relex_table_candidates')[0]!.args).toEqual({ p_after: null, p_limit: 500, p_tenant_key: 's:default' });
    expect(report.updated).toBe(1);
    expect(report.tables).toBe(1);
  });

  test('switch on: a chunk already serialized is left alone; switch off restores the plain text', async () => {
    const stored = (lexical: string) =>
      recordingRpc({
        rag_relex_table_candidates: (args) => ({ data: args.p_after === null ? [{ ...TABLE_ROW, lexical_text: lexical }] : [], error: null }),
        rag_relex_batch: () => ({ data: [{ rag_relex_batch: 1 }], error: null }),
      });
    const serialized = stored(SERIALIZED);
    expect((await runRelex({ db: serialized.db, tableRowSerialization: true })).updated).toBe(0);
    expect(callsOf(serialized.calls, 'rag_relex_batch')).toHaveLength(0);

    const off = stored(SERIALIZED);
    expect((await runRelex({ db: off.db, tableRowSerialization: false })).updated).toBe(1);
    expect(callsOf(off.calls, 'rag_relex_batch')[0]!.args.p_rows).toEqual([{ id: TABLE_ROW.id, lexical_text: PLAIN }]);
  });

  test('switch on: the stale pass writes the serialized text for a table chunk with an old lexical version', async () => {
    const { db, calls } = recordingRpc({
      rag_relex_candidates: (args) => ({ data: args.p_after === null ? [TABLE_ROW] : [], error: null }),
      rag_relex_batch: () => ({ data: [{ rag_relex_batch: 1 }], error: null }),
      rag_relex_table_candidates: () => ({ data: [], error: null }),
    });
    await runRelex({ db, tableRowSerialization: true });
    expect(callsOf(calls, 'rag_relex_batch')[0]!.args.p_rows).toEqual([{ id: TABLE_ROW.id, lexical_text: SERIALIZED }]);
  });

  test('a zh table chunk uses the zh separator; und falls back to the document language', async () => {
    const zhTable = '| 名称 | 数量 |\n| --- | --- |\n| 甲 | 1 |';
    const { db, calls } = recordingRpc({
      rag_relex_table_candidates: (args) => ({
        data: args.p_after === null ? [{ ...TABLE_ROW, content: zhTable, language: 'und', document_language: 'zh', lexical_text: '' }] : [],
        error: null,
      }),
      rag_relex_batch: () => ({ data: [{ rag_relex_batch: 1 }], error: null }),
    });
    await runRelex({ db, tableRowSerialization: true });
    const rows = callsOf(calls, 'rag_relex_batch')[0]!.args.p_rows as Array<{ lexical_text: string }>;
    expect(rows[0]!.lexical_text).toBe(
      chunkLexicalText({ sectionPath: ['Inventory'], content: zhTable, chunkKind: 'table', metadata: {}, documentFilename: 'inventory.md', tableRowSeparator: '，' }),
    );
  });

  test('a database without the table function: switch off skips the pass, switch on fails with a named error', async () => {
    const missing = () => recordingRpc({ rag_relex_table_candidates: () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }) });
    expect((await runRelex({ db: missing().db, tableRowSerialization: false })).updated).toBe(0);
    await expect(runRelex({ db: missing().db, tableRowSerialization: true })).rejects.toMatchObject({ code: 'rpc_failed:rag_relex_table_candidates' });
  });

  test('the dry run counts the table chunks a run would rewrite', async () => {
    const { db, calls } = recordingRpc({
      rag_relex_table_candidates: (args) => ({ data: args.p_after === null ? [{ ...TABLE_ROW, lexical_text: PLAIN }] : [], error: null }),
    });
    const report = await dryRunRelex({ db, tableRowSerialization: true });
    expect(report.tables).toBe(1);
    expect(report.total).toBe(1);
    expect(callsOf(calls, 'rag_relex_batch')).toHaveLength(0);
  });
});
