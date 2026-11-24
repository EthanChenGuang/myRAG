import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_TEXT_VERSION,
  buildEmbeddingText,
  renderTemplateHeader,
} from '@/lib/rag/ingest/text/embedding-text';

describe('buildEmbeddingText (D-24)', () => {
  it('pins the template version', () => {
    expect(EMBEDDING_TEXT_VERSION).toBe(1);
  });

  it('prefixes the section path joined by " > " and a blank line', () => {
    expect(buildEmbeddingText({ section_path: ['A', 'B'], content: 'x' })).toBe('A > B\n\nx');
  });

  it('puts the template header on its own line before the content', () => {
    expect(
      buildEmbeddingText({
        section_path: ['A', 'B'],
        content: 'x',
        template_header: 'Invoice FT-1 | ACME | IT99999999990',
      }),
    ).toBe('A > B\n\nInvoice FT-1 | ACME | IT99999999990\nx');
  });

  it('adds no prefix for an empty path', () => {
    expect(buildEmbeddingText({ section_path: [], content: 'x' })).toBe('x');
    expect(buildEmbeddingText({ section_path: [], content: 'x', template_header: 'H' })).toBe('H\nx');
  });

  it('is deterministic and keeps Chinese path elements as they are', () => {
    const input = { section_path: ['第三章 合同条款', '第5条 适用范围'], content: '本合同适用于甲乙双方。' };
    expect(buildEmbeddingText(input)).toBe('第三章 合同条款 > 第5条 适用范围\n\n本合同适用于甲乙双方。');
    expect(buildEmbeddingText(input)).toBe(buildEmbeddingText({ ...input }));
  });

  it('ignores an empty template header', () => {
    expect(buildEmbeddingText({ section_path: ['A'], content: 'x', template_header: '' })).toBe('A\n\nx');
  });
});

describe('renderTemplateHeader', () => {
  const row = { invoice_number: 'FT-1', supplier_name: 'ACME', supplier_tax_id: null, total: 1200 };

  it('fills placeholders from the row', () => {
    expect(renderTemplateHeader('Invoice {invoice_number} | {supplier_name}', row)).toBe('Invoice FT-1 | ACME');
    expect(renderTemplateHeader('Total {total}', row)).toBe('Total 1200');
  });

  it('drops a segment whose field is null or empty', () => {
    expect(renderTemplateHeader('Invoice {invoice_number} | {supplier_name} | {supplier_tax_id}', row)).toBe(
      'Invoice FT-1 | ACME',
    );
    expect(renderTemplateHeader('{supplier_tax_id}', row)).toBe('');
    expect(renderTemplateHeader('{a} | {b}', { a: '  ', b: 'ok' })).toBe('ok');
  });

  it('throws on an unknown placeholder', () => {
    expect(() => renderTemplateHeader('Invoice {nope}', row)).toThrow(/nope/);
    expect(() => renderTemplateHeader('{constructor}', row)).toThrow(/constructor/);
    expect(() => renderTemplateHeader('{Bad Name}', row)).toThrow();
  });

  it('keeps the header on one line', () => {
    expect(renderTemplateHeader('{a}', { a: 'x\ny\r\nz' })).toBe('x y z');
  });
});
