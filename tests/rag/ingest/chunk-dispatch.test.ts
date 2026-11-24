import { describe, expect, it } from 'vitest';
import { CHUNKERS, ChunkerUnavailableError, chunkDocument, type DoclingChunk } from '@/lib/rag/ingest/chunkers';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { chunkStage } from '@/lib/rag/ingest/stages/chunk';
import { emptyIngestState, type IngestWork, type StageContext } from '@/lib/rag/ingest/types';

const MARKDOWN = ['# 报告', '', '## 结果', '', '收入在第二季度增长。', '', '## 表格', '', '| 项目 | 金额 |', '| --- | --- |', '| 费用 | 10 |', ''].join('\n');

const DOCLING_CHUNKS: DoclingChunk[] = [
  {
    contextualized_text: '报告 > 结果\n收入在第二季度增长。',
    headings: ['报告', '结果'],
    is_table: false,
    pages: [1],
    table_header: null,
    text: '收入在第二季度增长。',
  },
  {
    contextualized_text: '报告 > 表格\n| 项目 | 金额 |\n| --- | --- |\n| 费用 | 10 |',
    headings: ['报告', '表格'],
    is_table: true,
    pages: [3, 2],
    table_header: '| 项目 | 金额 |\n| --- | --- |',
    text: '| 项目 | 金额 |\n| --- | --- |\n| 费用 | 10 |',
  },
];

const config = (docType: Parameters<typeof getProcessingProfile>[0]) => getProcessingProfile(docType).chunker;

function stageContext(docType: Parameters<typeof getProcessingProfile>[0], work: Partial<IngestWork>): StageContext {
  return {
    identity: {
      tenantKey: 's:default',
      filename: 'contract.md',
      fileSha256: 'x',
      docType,
      docTypeOrigin: 'picked',
      profile: getProcessingProfile(docType),
      bytes: null,
    },
    warnings: [],
    state: emptyIngestState(),
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0, ...work },
  } as unknown as StageContext;
}

describe('chunker dispatch', () => {
  it('registers markdown_sections, table_aware and legal_clauses and leaves invoice and image_caption to later plans', () => {
    expect(Object.keys(CHUNKERS).sort()).toEqual(['legal_clauses', 'markdown_sections', 'table_aware']);
    expect(() => chunkDocument(config('invoice_receipt'), { markdown: MARKDOWN })).toThrow(ChunkerUnavailableError);
    expect(() => chunkDocument({ ...config('general'), kind: 'image_caption' }, { markdown: MARKDOWN })).toThrow(ChunkerUnavailableError);
  });

  it('dispatches on the chunker kind of the profile data', () => {
    const sections = chunkDocument(config('general'), { markdown: MARKDOWN });
    expect(sections.chunks.map((chunk) => chunk.section_path)).toEqual([['报告', '结果'], ['报告', '表格']]);

    const legal = chunkDocument(config('contract_legal'), { markdown: '第三章 合同条款\n\n第5条 适用范围\n本条适用于全部设备。\n' });
    expect(legal.chunks.map((chunk) => chunk.section_path)).toEqual([['第三章 合同条款', '第5条 适用范围']]);

    const table = chunkDocument(config('financial_report'), { markdown: '## 表\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n' });
    expect(table.chunks.map((chunk) => chunk.chunk_kind)).toEqual(['table']);
  });

  it('uses Docling chunks under table_aware: headings, pages, is_table, plain text instead of contextualized text', () => {
    const { chunks, warnings } = chunkDocument(config('financial_report'), { markdown: MARKDOWN, chunks: DOCLING_CHUNKS });
    expect(warnings).toEqual([]);
    expect(chunks).toEqual([
      { content: '收入在第二季度增长。', section_path: ['报告', '结果'], chunk_kind: 'text', page_start: 1, page_end: 1, metadata: {} },
      {
        content: '| 项目 | 金额 |\n| --- | --- |\n| 费用 | 10 |',
        section_path: ['报告', '表格'],
        chunk_kind: 'table',
        page_start: 2,
        page_end: 3,
        metadata: {},
      },
    ]);
    const general = chunkDocument(config('general'), { markdown: MARKDOWN, chunks: DOCLING_CHUNKS });
    expect(general.chunks.map((chunk) => chunk.content)).toEqual(DOCLING_CHUNKS.map((chunk) => chunk.text));
  });

  it('chunks the Markdown when Docling gives no chunks, and ignores Docling chunks under legal_clauses', () => {
    const empty = chunkDocument(config('financial_report'), { markdown: MARKDOWN, chunks: [] });
    expect(empty.chunks.length).toBeGreaterThan(0);
    expect(empty.chunks.map((chunk) => chunk.section_path)).toEqual([['报告', '结果'], ['报告', '表格']]);

    const contract = '第5条 适用范围\n本条适用于全部设备。\n但以下情况除外：\n（一）已报废的设备；\n（二）已停用的设备。\n';
    const legal = chunkDocument(config('contract_legal'), { markdown: contract, chunks: DOCLING_CHUNKS });
    expect(legal.chunks).toHaveLength(1);
    expect(legal.chunks[0]?.section_path).toEqual(['第5条 适用范围']);
    expect(legal.chunks[0]?.content).toContain('（二）已停用的设备。');
  });
});

describe('chunk stage', () => {
  it('fills the work chunks from the kind in the profile, with the document metadata keys', async () => {
    const ctx = stageContext('general', { parseText: MARKDOWN });
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(ctx.work.chunks.map((chunk) => chunk.metadata)).toEqual([
      { document_title: 'contract.md', chunk_index: 0, chunk_position: 1, total_chunks: 2 },
      { document_title: 'contract.md', chunk_index: 1, chunk_position: 2, total_chunks: 2 },
    ]);
  });

  it('consumes the Docling chunks carried by the parse result', async () => {
    const ctx = stageContext('financial_report', { parseText: MARKDOWN, parseChunks: DOCLING_CHUNKS });
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'next' });
    expect(ctx.work.chunks.map((chunk) => [chunk.chunk_kind, chunk.page_start, chunk.page_end])).toEqual([
      ['text', 1, 1],
      ['table', 2, 3],
    ]);
  });

  it('fails with chunker_unavailable for a kind no plan has added yet and writes no chunks', async () => {
    const ctx = stageContext('invoice_receipt', { parseText: MARKDOWN });
    expect(await chunkStage.run(ctx)).toEqual({ kind: 'fail', reason: 'chunker_unavailable' });
    expect(ctx.work.chunks).toEqual([]);
    expect(ctx.warnings).toEqual([]);
  });

  it('reports chunker warnings and fails with no_chunks for an empty document', async () => {
    const huge = `| 超长行 | ${'很长的单元格内容'.repeat(400)} |`;
    const wide = stageContext('financial_report', { parseText: `## 明细\n\n| a | b |\n| --- | --- |\n${huge}\n` });
    expect(await chunkStage.run(wide)).toEqual({ kind: 'next' });
    expect(wide.warnings).toEqual(['oversized_table_row']);

    const blank = stageContext('financial_report', { parseText: '# Only headings\n' });
    expect(await chunkStage.run(blank)).toEqual({ kind: 'fail', reason: 'no_chunks' });
  });
});
