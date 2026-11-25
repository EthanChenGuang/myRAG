import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNKERS, chunkDocument, type ChunkerConfig } from '@/lib/rag/ingest/chunkers';
import { chunkParentChild } from '@/lib/rag/ingest/chunkers/parent-child';
import { buildProfileChunks } from '@/lib/rag/ingest/profile-chunks';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { chunkStage } from '@/lib/rag/ingest/stages/chunk';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';
import { emptyIngestState, type IngestWork, type StageContext } from '@/lib/rag/ingest/types';
import { resetLanguageSettingsForTests, setLanguageSettingsTrapForTests } from '@/lib/rag/lang/settings';
import { blockSplitterForIngest, joinSentences, segmentText, splitSentences, splitterFor } from '@/lib/rag/lang/sentences';
import { legacyChunkDigests } from './helpers/legacy-chunk-snapshot';

interface SentenceCase {
  name: string;
  language: string;
  text: string;
  budget_tokens: number | null;
  expect_segments: string[];
}

const ROOT = path.resolve(__dirname, '../..');
const CASES = (JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/lang/sentence-cases.json'), 'utf8')) as { cases: SentenceCase[] }).cases;
const SNAPSHOT = (JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/lang/chunk-legacy-snapshot.json'), 'utf8')) as { digests: Record<string, string> }).digests;

const ZH_SENTENCES = [
  '第一部分说明了系统的基本结构；它由三层组成，每一层都有自己的职责。',
  '第二部分介绍了数据如何在各层之间流动；流动的方向总是自上而下！',
  '第三部分回答了一个问题；为什么要把这些层分开来设计？',
  '第四部分给出了一些简单的例子；每个例子都很短，也很容易理解。',
  '第五部分是总结；它把前面几个部分的要点再说一遍。',
];
const EN_SENTENCES = [
  'The first part describes the basic structure of the system; it has three layers with their own duties.',
  'The second part shows how data moves between the layers; it always flows from the top down!',
  'The third part answers a question; why are these layers designed apart?',
  'The fourth part gives a few short examples; each one is brief and easy to follow.',
  'The last part is a summary; it repeats the main points of the earlier parts.',
];

const generalChunker = (maxTokens: number): ChunkerConfig => ({
  ...getProcessingProfile('general').chunker,
  max_tokens: maxTokens,
  overlap_tokens: 0,
  min_chunk_tokens: 0,
});

function stageContext(chunker: ChunkerConfig, markdown: string, languageAwareIngest: 'off' | 'on'): StageContext {
  const work: Partial<IngestWork> = { parseText: markdown, parseChunks: null };
  return {
    identity: {
      tenantKey: 's:default',
      filename: 'notes.md',
      fileSha256: 'x',
      docType: 'general',
      docTypeOrigin: 'picked',
      profile: { ...getProcessingProfile('general'), chunker },
      bytes: null,
    },
    config: { languageAwareIngest },
    warnings: [],
    state: emptyIngestState(),
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0, ...work },
  } as unknown as StageContext;
}

async function stageChunks(chunker: ChunkerConfig, markdown: string, mode: 'off' | 'on'): Promise<Array<{ content: string; section_path: string[] }>> {
  const ctx = stageContext(chunker, markdown, mode);
  const outcome = await chunkStage.run(ctx);
  expect(outcome).toEqual({ kind: 'next' });
  return ctx.work.chunks;
}

const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));

/** Every sentence that fits the budget lies inside one chunk. */
function expectSentencesWhole(chunks: ReadonlyArray<{ content: string }>, sentences: readonly string[]): void {
  for (const sentence of sentences) expect(chunks.some((chunk) => chunk.content.includes(sentence))).toBe(true);
}

const ENV_KEYS = ['RAG_SUPPORTED_LANGUAGES', 'RAG_PRIMARY_LANGUAGE'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
  process.env.RAG_PRIMARY_LANGUAGE = 'en';
  resetLanguageSettingsForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setLanguageSettingsTrapForTests(null);
  resetLanguageSettingsForTests();
});

describe('shared sentence cases (tests/fixtures/lang/sentence-cases.json)', () => {
  it.each(CASES.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const segments = segmentText(entry.text, entry.language, entry.budget_tokens);
    expect(segments).toEqual(entry.expect_segments);
    if (entry.budget_tokens !== null) for (const segment of segments) expect(countTokens(segment)).toBeLessThanOrEqual(entry.budget_tokens);
  });
});

describe('splitterFor', () => {
  it('ends zh sentences only at 。！？ and en and it sentences only at .!?, never at a semicolon', () => {
    expect(splitSentences('甲句；仍在甲句。乙句！丙句？', 'zh')).toEqual(['甲句；仍在甲句。', '乙句！', '丙句？']);
    expect(splitSentences('One; still one. Two! Three? Four', 'en')).toEqual(['One; still one.', 'Two!', 'Three?', 'Four']);
    expect(splitSentences('Uno; ancora uno. Due! Tre?', 'it')).toEqual(['Uno; ancora uno.', 'Due!', 'Tre?']);
  });

  it('joins zh sentences with nothing and en and it sentences with one space', () => {
    expect(joinSentences(['甲句。', '乙句。'], 'zh')).toBe('甲句。乙句。');
    expect(joinSentences(['One.', 'Two.'], 'en')).toBe('One. Two.');
    expect(joinSentences(['Uno.', 'Due.'], 'it')).toBe('Uno. Due.');
    expect(splitterFor('zh').join('甲句')).toBe('');
    expect(splitterFor('en').join('One')).toBe(' ');
  });
});

describe('language-aware section chunking through the chunk stage', () => {
  it('cuts a long zh section only after 。！？ with every chunk inside the cl100k_base budget', async () => {
    const chunker = generalChunker(70);
    const chunks = await stageChunks(chunker, ['# 说明', '', ZH_SENTENCES.join('')].join('\n'), 'on');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(chunker.max_tokens);
      expect(chunk.content).toMatch(/[。！？]$/u);
    }
    expectSentencesWhole(chunks, ZH_SENTENCES);
    expect(chunks.some((chunk) => chunk.content.includes('；'))).toBe(true);
  });

  it('cuts a long en section only after . ! or ? and re-joins its sentences with one space', async () => {
    const chunker = generalChunker(50);
    const chunks = await stageChunks(chunker, ['# Notes', '', EN_SENTENCES.join('\n')].join('\n'), 'on');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(chunker.max_tokens);
      expect(chunk.content).toMatch(/[.!?]$/u);
      expect(chunk.content).not.toContain('\n');
    }
    expectSentencesWhole(chunks, EN_SENTENCES);
  });

  it('switch off: today\'s splitter, semicolons included, and the language settings are never read', async () => {
    setLanguageSettingsTrapForTests(() => {
      throw new Error('language settings read with RAG_LANGUAGE_AWARE_INGEST=off');
    });
    const markdown = ['# 说明', '', ZH_SENTENCES.join('')].join('\n');
    const chunker = generalChunker(70);
    const off = await stageChunks(chunker, markdown, 'off');
    expect(off).toEqual(chunkDocument(chunker, { markdown }).chunks.map((draft, index, all) => ({
      ...draft,
      metadata: { document_title: 'notes.md', chunk_index: index, chunk_position: index + 1, total_chunks: all.length },
    })));
    expect(off.some((chunk) => chunk.content.endsWith('；'))).toBe(true);
  });

  it('switch off: every chunker output on the ingest fixtures equals the snapshot taken before the change', () => {
    setLanguageSettingsTrapForTests(() => {
      throw new Error('language settings read with RAG_LANGUAGE_AWARE_INGEST=off');
    });
    expect(legacyChunkDigests()).toEqual(SNAPSHOT);
  });
});

const ZH_MIXED = [
  '说明见第3.5节. 然后继续说明这一部分的内容；内容并不复杂，读起来也很顺畅。',
  '版本v2.0带来了很多变化；每一项变化都需要单独记录下来。',
  '第三段解释了这些变化的原因；原因主要来自使用中的反馈！',
  '最后一段给出总结；总结很短，只有一句话？',
];
const MIXED_MARKDOWN = ['# 文档', '', ZH_MIXED.join(''), '', EN_SENTENCES.join(' '), ''].join('\n');
const LEGAL_MARKDOWN = ['第一章 总则', '', '第1条 范围', ZH_MIXED.join(''), '', EN_SENTENCES.join(' '), ''].join('\n');
const TABLE_MARKDOWN = ['## 表格', '', '| 项目 | 数量 |', '| --- | --- |', '| 甲 | 1 |', '| 乙 | 2 |', '', ZH_MIXED.join(''), '', EN_SENTENCES.join(' '), ''].join('\n');
const SENTENCE_TAIL = /[。！？.!?]$/u;

/** Text chunks end at a sentence end of their own block language and keep every sentence of both blocks whole. */
function expectPerBlockBoundaries(chunks: ReadonlyArray<{ content: string; chunk_kind: string }>): void {
  const text = chunks.filter((chunk) => chunk.chunk_kind === 'text');
  expect(text.length).toBeGreaterThan(2);
  for (const chunk of text) {
    expect(chunk.content).toMatch(SENTENCE_TAIL);
    expect(chunk.content).not.toMatch(/[;；]$/u);
  }
  expectSentencesWhole(chunks, ZH_MIXED);
  expectSentencesWhole(chunks, EN_SENTENCES);
}

describe('every TS chunker splits each block by its own language', () => {
  const on = (): ReturnType<typeof blockSplitterForIngest> => blockSplitterForIngest('on');

  it('markdown_sections: a zh block keeps 3.5 and "节. 然后" together, an en block splits at . ! ?', () => {
    const chunker = generalChunker(64);
    expectPerBlockBoundaries(CHUNKERS.markdown_sections!(MIXED_MARKDOWN, chunker, on()).chunks);
  });

  it('legal_clauses: an over-long clause body is cut at the sentence ends of each block', () => {
    const chunker: ChunkerConfig = { ...getProcessingProfile('contract_legal').chunker, max_tokens: 72, min_chunk_tokens: 0 };
    const chunks = CHUNKERS.legal_clauses!(LEGAL_MARKDOWN, chunker, on()).chunks;
    expect(chunks.every((chunk) => chunk.section_path.join('/') === '第一章 总则/第1条 范围')).toBe(true);
    expectPerBlockBoundaries(chunks);
  });

  it('table_aware: rows stay whole and text blocks follow their language', () => {
    const chunker: ChunkerConfig = { ...getProcessingProfile('financial_report').chunker, max_tokens: 64, overlap_tokens: 0, min_chunk_tokens: 0 };
    const chunks = CHUNKERS.table_aware!(TABLE_MARKDOWN, chunker, on()).chunks;
    expect(chunks.some((chunk) => chunk.content.includes('| 甲 | 1 |') && chunk.content.includes('| 乙 | 2 |'))).toBe(true);
    expectPerBlockBoundaries(chunks);
  });

  it.each(['none', 'structure', 'fixed'] as const)('parent-child (%s): children and fixed parents use the same rule', (parentMode) => {
    const chunker = generalChunker(512);
    const result = chunkParentChild(MIXED_MARKDOWN, { childTokens: 64, parentMode, parentTokens: parentMode === 'none' ? null : 160 }, chunker, on());
    expectPerBlockBoundaries(result.children);
    for (const parent of result.parents) expect(parent.content).toMatch(SENTENCE_TAIL);
  });

  it('buildProfileChunks (rag:rechunk and the write stage) takes the switch: on splits per block, off equals today', () => {
    const profile = { id: 'p-64', docType: 'general', childTokens: 64, parentMode: 'none' as const, parentTokens: null, status: 'building' as const };
    const document = { filename: 'notes.md', chunker: generalChunker(512) };
    const built = buildProfileChunks({ ...document, languageAwareIngest: 'on' }, MIXED_MARKDOWN, profile);
    expectPerBlockBoundaries(built.children);

    setLanguageSettingsTrapForTests(() => {
      throw new Error('language settings read with RAG_LANGUAGE_AWARE_INGEST=off');
    });
    const off = buildProfileChunks({ ...document, languageAwareIngest: 'off' }, MIXED_MARKDOWN, profile);
    expect(off).toEqual(buildProfileChunks(document, MIXED_MARKDOWN, profile));
    expect(off.children.some((child) => /[;；]$/u.test(child.content) || child.content.endsWith('第3.5节.'))).toBe(true);
  });

  it('a monolingual zh setting never splits at an ASCII full stop; und text falls back to the primary language', () => {
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh';
    process.env.RAG_PRIMARY_LANGUAGE = 'zh';
    resetLanguageSettingsForTests();
    expect(blockSplitterForIngest('on')('Plain words. More words.').language).toBe('zh');
    process.env.RAG_SUPPORTED_LANGUAGES = 'zh,en,it';
    process.env.RAG_PRIMARY_LANGUAGE = 'it';
    resetLanguageSettingsForTests();
    expect(blockSplitterForIngest('on')('12345 67890. 13579').language).toBe('it');
    expect(blockSplitterForIngest('on')(ZH_MIXED[0]!).language).toBe('zh');
  });

  it('a 200,000-character single sentence is scanned in linear time', () => {
    const started = Date.now();
    expect(splitSentences('字'.repeat(200_000), 'zh')).toHaveLength(1);
    expect(splitSentences('a'.repeat(200_000), 'en')).toHaveLength(1);
    expect(splitSentences('.'.repeat(200_000), 'en')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
