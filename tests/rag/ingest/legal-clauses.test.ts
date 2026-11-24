import { describe, expect, it } from 'vitest';
import { chunkLegalClauses, type LegalChunkOptions } from '@/lib/rag/ingest/chunkers/legal-clauses';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const DATA = getProcessingProfile('contract_legal').chunker;
const OPTIONS: LegalChunkOptions = {
  maxTokens: 300,
  overlapTokens: 0,
  minChunkTokens: 0,
  repeatTableHeader: false,
  clause_patterns: DATA.clause_patterns ?? [],
  lead_in_phrases: DATA.lead_in_phrases ?? [],
};

const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));
const lines = (...parts: string[]): string => parts.join('\n');

describe('legal clause chunker', () => {
  it('keeps a Chinese clause with its exception lead-in and the whole list as one chunk under chapter and clause path', () => {
    const items = ['（一）设备已由乙方书面确认报废；', '（二）设备处于不可抗力造成的停用状态；', '（三）设备被甲方擅自拆卸或改装；', '（四）设备已超过保修期限。'];
    const markdown = lines(
      '第三章 合同条款',
      '',
      '第5条 适用范围',
      '本条适用于甲方提供的全部设备。',
      '但以下情况除外：',
      ...items,
      '',
      '第6条 付款',
      '甲方应在十五日内付款。',
    );
    const { chunks, warnings } = chunkLegalClauses(markdown, OPTIONS);
    expect(warnings).toEqual([]);
    expect(chunks.map((chunk) => chunk.section_path)).toEqual([
      ['第三章 合同条款', '第5条 适用范围'],
      ['第三章 合同条款', '第6条 付款'],
    ]);
    expect(chunks[0]?.content).toBe(lines('第5条 适用范围', '本条适用于甲方提供的全部设备。', '但以下情况除外：', ...items));
    expect(chunks[0]?.chunk_kind).toBe('text');
    for (const chunk of chunks) expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);
  });

  it('keeps English and Italian exception lists whole', () => {
    const en = lines('Article 7 Warranty', 'The supplier warrants the goods, except as follows:', '(a) wear and tear;', '(b) misuse by the buyer;', '(c) repairs by third parties.', '', 'Article 8 Notices', 'Notices are given in writing.');
    const it = lines('Articolo 4 Garanzia', 'Il fornitore garantisce la merce, salvo quanto segue:', 'a) usura normale;', 'b) uso improprio;', 'c) riparazioni di terzi.', '', 'Articolo 5 Comunicazioni', 'Le comunicazioni sono scritte.');
    for (const [markdown, heading, lastItem] of [
      [en, 'Article 7 Warranty', '(c) repairs by third parties.'],
      [it, 'Articolo 4 Garanzia', 'c) riparazioni di terzi.'],
    ] as const) {
      const { chunks } = chunkLegalClauses(markdown, OPTIONS);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]?.section_path).toEqual([heading]);
      expect(chunks[0]?.content.startsWith(`${heading}\n`)).toBe(true);
      expect(chunks[0]?.content.endsWith(lastItem)).toBe(true);
    }
  });

  it('recognises numbered and bracketed headings and ignores a digit that is not followed by a space', () => {
    const numbered = lines('1. Definitions', '1.1 "Goods" means the products.', '1.2 "Buyer" means the purchaser.', '2. Term', '3个月内付款的，视为按期付款。', 'The term is two years.');
    const first = chunkLegalClauses(numbered, OPTIONS).chunks;
    expect(first.map((chunk) => chunk.section_path)).toEqual([['1. Definitions'], ['2. Term']]);
    expect(first[0]?.content).toBe(lines('1. Definitions', '1.1 "Goods" means the products.', '1.2 "Buyer" means the purchaser.'));
    expect(first[1]?.content).toBe(lines('2. Term', '3个月内付款的，视为按期付款。', 'The term is two years.'));

    const bracketed = lines('（一）总则', '本合同依法订立。', '（二）定义', '本合同所称设备是指甲方的全部设备。');
    expect(chunkLegalClauses(bracketed, OPTIONS).chunks.map((chunk) => chunk.section_path)).toEqual([['（一）总则'], ['（二）定义']]);
  });

  it('splits an over-long clause at item boundaries with the heading and lead-in on every piece', () => {
    const lead = '乙方应按以下方式保存记录，但以下情况除外：';
    const items = Array.from({ length: 30 }, (_, i) => `- 设备 ${i} 的维护记录应当由乙方保存三年并随时接受检查。`);
    const markdown = lines('第9条 履行方式', '乙方应当按约定履行义务。', '', lead, ...items);
    const { chunks } = chunkLegalClauses(markdown, { ...OPTIONS, maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.section_path).toEqual(['第9条 履行方式']);
      expect(chunk.content.split('\n')[0]).toBe('第9条 履行方式');
      expect(chunk.content.includes(lead)).toBe(true);
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(300);
    }
    expect(chunks.filter((chunk) => chunk.content.includes('乙方应当按约定履行义务。'))).toHaveLength(1);
    expect(chunks[0]?.content).toContain(`${lead}\n${items[0]}`);
    for (const chunk of chunks.slice(1)) expect(chunk.content.split('\n')[1]).toBe(lead);
    const seen = chunks.flatMap((chunk) => chunk.content.split('\n').filter((line) => line.startsWith('- ')));
    expect(seen).toEqual(items);
  });

  it('falls back to sentence splits with the heading repeated for a single over-long item', () => {
    const sentence = '乙方不得向任何第三方披露甲方的商业秘密。';
    const item = `- ${sentence.repeat(40)}`;
    const { chunks } = chunkLegalClauses(lines('第3条 保密', item), OPTIONS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.section_path).toEqual(['第3条 保密']);
      expect(chunk.content.startsWith('第3条 保密\n')).toBe(true);
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);
    }
    const body = chunks.map((chunk) => chunk.content.split('\n').slice(1).join('\n')).join('');
    expect(body).toBe(item);
  });

  it('takes clause patterns and lead-in phrases from the profile data it is given', () => {
    const custom: LegalChunkOptions = { ...OPTIONS, clause_patterns: ['^§\\s*\\d+'], lead_in_phrases: ['unless noted below'] };
    const markdown = lines('§ 1 Scope', 'Applies to all orders.', '§ 2 Returns', 'Goods may be returned, unless noted below:', '- opened packs', '- custom orders');
    const { chunks } = chunkLegalClauses(markdown, custom);
    expect(chunks.map((chunk) => chunk.section_path)).toEqual([['§ 1 Scope'], ['§ 2 Returns']]);
    expect(chunks[1]?.content.endsWith('- custom orders')).toBe(true);

    const none = chunkLegalClauses(markdown, { ...custom, clause_patterns: [] }).chunks;
    expect(none).toHaveLength(1);
    expect(none[0]?.section_path).toEqual([]);

    const long = lines('§ 3 Returns', 'Goods may be returned, unless noted below:', ...Array.from({ length: 30 }, (_, i) => `- excluded product line ${i} covering opened packs`));
    const withLead = chunkLegalClauses(long, { ...custom, maxTokens: 150 }).chunks;
    expect(withLead.length).toBeGreaterThan(1);
    for (const chunk of withLead) expect(chunk.content.split('\n')[1]).toBe('Goods may be returned, unless noted below:');
    const withoutLead = chunkLegalClauses(long, { ...custom, maxTokens: 150, lead_in_phrases: [] }).chunks;
    expect(withoutLead.slice(1).every((chunk) => !chunk.content.includes('Goods may be returned'))).toBe(true);
  });

  it('builds the outer path from Markdown headings and 第X章, with a Markdown clause heading as the last element', () => {
    const markdown = lines(
      '# 服务合同',
      '',
      '## 第一章 总则',
      '',
      '### 第1条 目的',
      '为规范服务，订立本合同。',
      '',
      '### 第2条 定义',
      '本合同所称服务是指巡检。',
      '',
      '## 第二章 费用',
      '',
      '第3条 价款',
      '年度服务费为人民币三万元。',
    );
    const { chunks } = chunkLegalClauses(markdown, OPTIONS);
    expect(chunks.map((chunk) => chunk.section_path)).toEqual([
      ['服务合同', '第一章 总则', '第1条 目的'],
      ['服务合同', '第一章 总则', '第2条 定义'],
      ['服务合同', '第二章 费用', '第3条 价款'],
    ]);
    expect(chunks[0]?.content).toBe('第1条 目的\n为规范服务，订立本合同。');
  });

  it('chunks the preamble as plain text and does not start a clause at a cross-reference inside a sentence', () => {
    const markdown = lines('甲方：示例有限公司', '乙方：样本股份有限公司', '', '第1条 范围', '本条所称服务，依据第5条的规定提供。', '', '第5条 费用', '费用按季度结算。');
    const { chunks } = chunkLegalClauses(markdown, OPTIONS);
    expect(chunks.map((chunk) => chunk.section_path)).toEqual([[], ['第1条 范围'], ['第5条 费用']]);
    expect(chunks[0]?.content).toBe('甲方：示例有限公司\n乙方：样本股份有限公司');
    expect(chunks[1]?.content).toBe('第1条 范围\n本条所称服务，依据第5条的规定提供。');
  });

  it('keeps a one-line clause that is longer than the heading allowance within the budget', () => {
    const clause = `第5条 ${'乙方应当在三十日内向甲方支付全部款项，逾期按日支付违约金。'.repeat(25)}`;
    const { chunks } = chunkLegalClauses(lines(clause), { ...OPTIONS, maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith('第5条')).toBe(true);
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(200);
    }
    expect(chunks.every((chunk) => chunk.section_path[chunk.section_path.length - 1] === '第5条')).toBe(true);
  });
});
