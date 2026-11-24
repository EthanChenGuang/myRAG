import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHUNKERS, chunkDocument } from '@/lib/rag/ingest/chunkers';
import { chunkInvoice } from '@/lib/rag/ingest/chunkers/invoice';
import type { MarkdownChunkOptions } from '@/lib/rag/ingest/chunkers/markdown-sections';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const RECORDED = path.resolve(__dirname, '../../../eval/fixtures/ingest/recorded');
const OPTIONS: MarkdownChunkOptions = { maxTokens: 1024, overlapTokens: 0, minChunkTokens: 0, repeatTableHeader: true };

function recorded(name: string): string {
  return (JSON.parse(fs.readFileSync(path.join(RECORDED, `${name}.parse.json`), 'utf8')) as { markdown: string }).markdown;
}

const CASES = [
  { name: 'invoice-zh', number: 'FP-2025-00417', header: '| 项目名称   |   数量 |     单价 | 金额        | 税率   | 税额      |', rows: ['测试传感器', '安装服务', '合计'], totals: '价税合计（小写）：¥1,130.00' },
  { name: 'invoice-en', number: 'INV-2025-00418', header: '| Description     |   Qty |   Unit price |   Amount |', rows: ['Thermal probe', 'Probe cable 5 m'], totals: 'Total: EUR 1,200.00' },
  { name: 'invoice-it', number: 'FT-2025-00419', header: '| Descrizione          |   Quantità |', rows: ['Sonda termica', 'Cavo di ricambio 5 m'], totals: 'Totale documento: € 1.220,00' },
];

const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));

describe('invoice chunker', () => {
  for (const sample of CASES) {
    it(`keeps the header block and the line-item table with its header in one invoice_header chunk (${sample.name})`, () => {
      const { chunks, warnings } = chunkInvoice(recorded(sample.name), OPTIONS);
      expect(warnings).toEqual([]);
      const first = chunks[0];
      expect(first?.chunk_kind).toBe('invoice_header');
      expect(first?.content).toContain(sample.number);
      expect(first?.content).toContain(sample.header);
      expect(first?.content).toMatch(/\n\|[-: |]+\|\n/);
      for (const row of sample.rows) expect(first?.content).toContain(row);
      expect(first!.content.indexOf(sample.number)).toBeLessThan(first!.content.indexOf(sample.header));
      expect(embeddingTokens(first!)).toBeLessThanOrEqual(OPTIONS.maxTokens);
    });
  }

  it('leaves the text after the table to the markdown_sections rules, as text chunks', () => {
    const { chunks } = chunkInvoice(recorded('invoice-en'), OPTIONS);
    expect(chunks.map((chunk) => chunk.chunk_kind)).toEqual(['invoice_header', 'text']);
    expect(chunks[1]?.content).toContain('Total: EUR 1,200.00');
    expect(chunks[1]?.content).not.toContain('|');
  });

  it('splits a line-item table that is too large by rows, repeats its header, and keeps the header block whole', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| Item ${i} | ${i + 1} | ${10 + i}.00 | ${(i + 1) * (10 + i)}.00 |`);
    const table = ['| Description | Qty | Unit price | Amount |', '| --- | --- | --- | --- |', ...rows].join('\n');
    const markdown = `## Invoice\n\nInvoice No.: INV-2025-00500\n\nSupplier: Example Supplier Ltd\n\n${table}\n\nTotal: EUR 99.00\n`;
    const options = { ...OPTIONS, maxTokens: 200 };
    const { chunks } = chunkInvoice(markdown, options);

    const header = chunks.find((chunk) => chunk.chunk_kind === 'invoice_header');
    expect(header?.content).toBe('Invoice No.: INV-2025-00500\n\nSupplier: Example Supplier Ltd');
    expect(header?.content).not.toContain('|');

    const pieces = chunks.filter((chunk) => chunk.chunk_kind === 'table');
    expect(pieces.length).toBeGreaterThan(2);
    const seen: string[] = [];
    for (const piece of pieces) {
      expect(piece.content.startsWith('| Description | Qty | Unit price | Amount |\n| --- | --- | --- | --- |\n')).toBe(true);
      expect(embeddingTokens(piece)).toBeLessThanOrEqual(options.maxTokens);
      seen.push(...piece.content.split('\n').slice(2));
    }
    expect(seen).toEqual(rows);
    expect(chunks.at(-1)?.content).toContain('Total: EUR 99.00');
  });

  it('chunks an invoice with no table, or with a table first, as plain sections', () => {
    const noTable = chunkInvoice('## Invoice\n\nInvoice No.: INV-1\n\nTotal: EUR 5.00\n', OPTIONS);
    expect(noTable.chunks.map((chunk) => chunk.chunk_kind)).toEqual(['text']);
    const tableFirst = chunkInvoice('## Invoice\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n', OPTIONS);
    expect(tableFirst.chunks.map((chunk) => chunk.chunk_kind)).toEqual(['table']);
  });

  it('is registered for the invoice profile and ignores Docling chunks', () => {
    expect(CHUNKERS.invoice).toBeTypeOf('function');
    const config = getProcessingProfile('invoice_receipt').chunker;
    const result = chunkDocument(config, {
      markdown: recorded('invoice-it'),
      chunks: [{ text: 'x', contextualized_text: 'x', headings: [], is_table: false, pages: [1], table_header: null }],
    });
    expect(result.chunks[0]?.chunk_kind).toBe('invoice_header');
    expect(result.chunks[0]?.content).toContain('FT-2025-00419');
  });
});
