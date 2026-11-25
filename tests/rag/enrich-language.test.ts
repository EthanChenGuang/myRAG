import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadIngestConfig } from '@/lib/rag/ingest/config';
import {
  UND,
  UND_CONFIDENCE_FLOOR,
  chunkLanguageFrom,
  detectChunkLanguage,
  detectChunkLanguages,
  documentLanguages,
  processingLanguage,
  roundConfidence,
  type ChunkLanguage,
  type ChunkLanguageOptions,
} from '@/lib/rag/ingest/lang/chunk-language';
import { toWrites } from '@/lib/rag/ingest/stages/embed-write';
import { enrichStage } from '@/lib/rag/ingest/stages/enrich';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { emptyIngestState, type ChunkDraft, type StageContext } from '@/lib/rag/ingest/types';
import type { DocumentFields, IngestWriter } from '@/lib/rag/ingest/writer';
import { detectLanguageWithConfidence } from '@/lib/rag/lang/detect';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import vectors from '../fixtures/ingest/lang-vectors.json';

const ZH_CHUNK = [
  '本节说明系统的总体结构以及各个组成部分之间的关系。',
  '每个模块都有明确的职责，模块之间通过约定的接口交换数据。',
  '数据在进入系统之前会经过校验，校验失败的数据不会被保存。',
  '运行期间产生的记录按照时间顺序保存，便于之后查阅和比较。',
  '配置项集中保存在一个文件中，修改之后需要重新启动服务才能生效。',
  '当某个模块出现异常时，其余模块继续工作，异常信息会被单独记录。',
].join('');
const EN_CHUNK =
  'This section describes the general structure of the system and the relation between its parts. Each module has a clear task and the modules exchange data through agreed interfaces. Records produced while the service runs are kept in time order, so that they can be read and compared later on.';
const TABLE_CHUNK = '| 12 | 34 |\n| 56 | 78 |';

const ZH_EN_IT: ChunkLanguageOptions = { candidates: ['zh', 'en', 'it'], primary: 'en', monolingual: false };

function draft(content: string): ChunkDraft {
  return { content, section_path: [], chunk_kind: 'text', page_start: null, page_end: null, metadata: {} };
}

function stageContext(contents: string[], switchValue: 'on' | 'off' | undefined) {
  const calls: Array<{ documentId: string; fields: DocumentFields }> = [];
  const setFields = vi.fn(async (documentId: string, fields: DocumentFields) => {
    calls.push({ documentId, fields });
  });
  const ctx = {
    document: { id: 'doc-1', version: 1, resumed: false },
    identity: { tenantKey: 's:default', filename: 'notes.md', fileSha256: 'x', docType: 'general', docTypeOrigin: 'default', bytes: null },
    config: loadIngestConfig(switchValue === undefined ? {} : { RAG_LANGUAGE_AWARE_INGEST: switchValue }),
    state: emptyIngestState(),
    work: { parseText: contents.join('\n\n'), parserVersion: null, chunks: contents.map(draft), chunksWritten: 0 },
    writer: { setFields } as unknown as IngestWriter,
  } as unknown as StageContext;
  return { ctx, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetLanguageSettingsForTests();
});

describe('enrich: per-chunk language (D-13, LANG-05)', () => {
  test('switch off (unset and off): one document language write and chunk writes without language keys, as before the change', async () => {
    for (const value of [undefined, 'off'] as const) {
      const { ctx, calls } = stageContext([ZH_CHUNK, EN_CHUNK, TABLE_CHUNK], value);
      await enrichStage.run(ctx);
      expect(calls).toEqual([{ documentId: 'doc-1', fields: { language: 'zh' } }]);
      for (const chunk of ctx.work.chunks) {
        expect(chunk).not.toHaveProperty('language');
        expect(chunk).not.toHaveProperty('language_confidence');
      }
      const writes = toWrites(ctx);
      expect(writes.map((write) => Object.keys(write).sort())).toEqual(
        writes.map(() =>
          ['chunk_index', 'chunk_kind', 'content', 'content_hash', 'embedding_text_version', 'lexical_text', 'metadata', 'page_end', 'page_start', 'section_path'],
        ),
      );
    }
  });

  test('switch off: a document without letters writes no language at all', async () => {
    const { ctx, calls } = stageContext([TABLE_CHUNK], 'off');
    await enrichStage.run(ctx);
    expect(calls).toEqual([]);
  });

  test('switch on: a zh/en document with a numbers-only table gets zh, en and und chunks, the dominant language and the list', async () => {
    const tokens = [ZH_CHUNK, EN_CHUNK, TABLE_CHUNK].map(countTokens);
    const total = tokens[0]! + tokens[1]! + tokens[2]!;
    expect(tokens[0]! / total).toBeCloseTo(0.7, 1);
    expect(tokens[1]! / total).toBeCloseTo(0.25, 1);
    expect(tokens[2]! / total).toBeLessThan(0.08);

    const { ctx, calls } = stageContext([ZH_CHUNK, EN_CHUNK, TABLE_CHUNK], 'on');
    await enrichStage.run(ctx);
    expect(ctx.work.chunks.map((chunk) => chunk.language)).toEqual(['zh', 'en', UND]);
    for (const chunk of ctx.work.chunks) {
      expect(chunk.language_confidence).toBeGreaterThanOrEqual(0);
      expect(chunk.language_confidence).toBeLessThanOrEqual(1);
    }
    expect(ctx.work.chunks[2]!.language_confidence).toBe(0);
    expect(calls).toEqual([{ documentId: 'doc-1', fields: { language: 'zh', languages: ['zh', 'en'] } }]);

    const writes = toWrites(ctx);
    expect(writes.map((write) => write.language)).toEqual(['zh', 'en', UND]);
    expect(writes.map((write) => write.language_confidence)).toEqual(ctx.work.chunks.map((chunk) => chunk.language_confidence));
  });

  test('switch on without configured languages runs the switch-off path', async () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', '');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', '');
    resetLanguageSettingsForTests();
    const { ctx, calls } = stageContext([ZH_CHUNK, TABLE_CHUNK], 'on');
    await enrichStage.run(ctx);
    expect(calls).toEqual([{ documentId: 'doc-1', fields: { language: 'zh' } }]);
    expect(ctx.work.chunks[1]).not.toHaveProperty('language');
  });

  test('monolingual en: a Chinese chunk is stored as en with confidence 1 and und is never written', async () => {
    vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en');
    vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
    resetLanguageSettingsForTests();
    const { ctx, calls } = stageContext([ZH_CHUNK, TABLE_CHUNK, '   '], 'on');
    await enrichStage.run(ctx);
    expect(ctx.work.chunks.map((chunk) => [chunk.language, chunk.language_confidence])).toEqual([
      ['en', 1],
      ['en', 1],
      ['en', 1],
    ]);
    expect(calls).toEqual([{ documentId: 'doc-1', fields: { language: 'en', languages: ['en'] } }]);
  });

  test('switch on, all chunks und: no document language is written and the list is empty', async () => {
    const { ctx, calls } = stageContext([TABLE_CHUNK, '2025 / 42'], 'on');
    await enrichStage.run(ctx);
    expect(ctx.work.chunks.map((chunk) => chunk.language)).toEqual([UND, UND]);
    expect(calls).toEqual([{ documentId: 'doc-1', fields: { languages: [] } }]);
  });

  test('switch on, no chunk: no document language is written and the list is empty', async () => {
    const { ctx, calls } = stageContext([], 'on');
    await enrichStage.run(ctx);
    expect(calls).toEqual([{ documentId: 'doc-1', fields: { languages: [] } }]);
  });
});

describe('chunk language boundaries (edge LANG-05)', () => {
  test('the floor keeps every vector marked confident detected', () => {
    for (const vector of vectors.vectors) {
      if (!vector.confident || vector.language === null) continue;
      expect(vector.confidence, vector.name).toBeGreaterThanOrEqual(UND_CONFIDENCE_FLOOR);
    }
  });

  test('confidence exactly at the floor keeps its language and one step below is und', () => {
    expect(chunkLanguageFrom({ language: 'en', confident: true, confidence: UND_CONFIDENCE_FLOOR })).toEqual({
      language: 'en',
      confidence: UND_CONFIDENCE_FLOOR,
    });
    expect(chunkLanguageFrom({ language: 'en', confident: true, confidence: UND_CONFIDENCE_FLOOR - 0.0001 })).toEqual({
      language: UND,
      confidence: UND_CONFIDENCE_FLOOR - 0.0001,
    });
    expect(chunkLanguageFrom({ language: 'en', confident: true, confidence: UND_CONFIDENCE_FLOOR - 0.00004 })).toEqual({
      language: 'en',
      confidence: UND_CONFIDENCE_FLOOR,
    });
  });

  test('an en/it stopword tie is und at chunk level while the detector still answers as today', () => {
    const tie = 'the and il la';
    expect(detectLanguageWithConfidence(tie)).toEqual({ language: 'en', confident: false, confidence: 0 });
    expect(detectChunkLanguage(tie, ZH_EN_IT)).toEqual({ language: UND, confidence: 0 });
  });

  test('an empty and a whitespace-only chunk are und with confidence 0', () => {
    expect(detectChunkLanguages(['', ' \n\t '], ZH_EN_IT)).toEqual([
      { language: UND, confidence: 0 },
      { language: UND, confidence: 0 },
    ]);
  });

  test('a confidence with more than four decimals is stored rounded to four', () => {
    const result = detectChunkLanguage('本合同 the contract 有效 is valid', ZH_EN_IT);
    expect(result.language).toBe('zh');
    expect(result.confidence).toBe(0.5109);
    expect(roundConfidence(0.123456)).toBe(0.1235);
    expect(roundConfidence(1 / 6)).toBe(0.1667);
    expect(roundConfidence(-0.2)).toBe(0);
    expect(roundConfidence(Number.NaN)).toBe(0);
  });

  test('a language with exactly 10% of the tokens is listed and one with 99 of 1000 is not', () => {
    const results: ChunkLanguage[] = [
      { language: 'en', confidence: 1 },
      { language: 'it', confidence: 1 },
    ];
    expect(documentLanguages(results, [900, 100])).toEqual({ language: 'en', languages: ['en', 'it'] });
    expect(documentLanguages(results, [901, 99])).toEqual({ language: 'en', languages: ['en'] });
  });

  test('und tokens count for no language and stay out of the total', () => {
    const results: ChunkLanguage[] = [
      { language: 'en', confidence: 1 },
      { language: 'it', confidence: 1 },
      { language: UND, confidence: 0 },
    ];
    expect(documentLanguages(results, [900, 100, 5000])).toEqual({ language: 'en', languages: ['en', 'it'] });
  });

  test('two languages with equal token totals resolve to the earlier one in registry order', () => {
    const results: ChunkLanguage[] = [
      { language: 'it', confidence: 1 },
      { language: 'en', confidence: 1 },
    ];
    expect(documentLanguages(results, [300, 300])).toEqual({ language: 'en', languages: ['en', 'it'] });
  });

  test('languages are listed in registry order whatever the input order (it, zh gives zh, it)', () => {
    const results: ChunkLanguage[] = [
      { language: 'it', confidence: 1 },
      { language: 'zh', confidence: 1 },
    ];
    expect(documentLanguages(results, [500, 400]).languages).toEqual(['zh', 'it']);
  });

  test('zero chunks, or only und chunks, give no document language and an empty list', () => {
    expect(documentLanguages([], [])).toEqual({ language: null, languages: [] });
    expect(documentLanguages([{ language: UND, confidence: 0 }], [40])).toEqual({ language: null, languages: [] });
  });

  test('monolingual mode never detects: every chunk gets the language with confidence 1', () => {
    const options: ChunkLanguageOptions = { candidates: ['en'], primary: 'en', monolingual: true };
    expect(detectChunkLanguages([ZH_CHUNK, '', TABLE_CHUNK], options)).toEqual([
      { language: 'en', confidence: 1 },
      { language: 'en', confidence: 1 },
      { language: 'en', confidence: 1 },
    ]);
  });

  test('a und chunk is processed with the primary language pack', () => {
    expect(processingLanguage(UND, 'en')).toBe('en');
    expect(processingLanguage('zh', 'en')).toBe('zh');
  });
});
