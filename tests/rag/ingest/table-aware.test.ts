import { describe, expect, it } from 'vitest';
import { splitTableBlocks } from '@/lib/rag/ingest/chunkers/markdown-tables';
import { chunkMarkdownSections, type MarkdownChunkOptions } from '@/lib/rag/ingest/chunkers/markdown-sections';
import { chunkTableAware } from '@/lib/rag/ingest/chunkers/table-aware';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const OPTIONS: MarkdownChunkOptions = { maxTokens: 200, overlapTokens: 0, minChunkTokens: 0, repeatTableHeader: true };
const HEADER = '|科目|期末余额|期初余额|备注|';
const SEPARATOR = '|---|---|---|---|';
const ROWS = Array.from({ length: 40 }, (_, i) => `|科目${i}|${1000 + i}.00|${2000 + i}.00|说明文字${i}|`);
const BIG_TABLE = [HEADER, SEPARATOR, ...ROWS].join('\n');

const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));

describe('markdown table blocks', () => {
  it('finds a header table, a headerless pipe run and leaves pipes inside a code fence as text', () => {
    const lines = ['intro', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '| x | y |', '| z | w |', '', '```', '| c | d |', '| --- | --- |', '```'];
    const blocks = splitTableBlocks(lines);
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'table', 'text', 'table', 'text']);
    expect(blocks[1]).toEqual({ kind: 'table', header: '| a | b |\n| --- | --- |', rows: ['| 1 | 2 |'] });
    expect(blocks[3]).toEqual({ kind: 'table', header: null, rows: ['| x | y |', '| z | w |'] });
    expect(blocks[4]?.kind === 'text' && blocks[4].lines.includes('| c | d |')).toBe(true);
  });
});

describe('table-aware chunker', () => {
  it('splits a 40-row table by rows, repeats the header and separator on every piece and respects max_tokens', () => {
    const { chunks, warnings } = chunkTableAware(`## 资产负债表\n\n${BIG_TABLE}\n`, OPTIONS);
    expect(chunks.length).toBeGreaterThan(2);
    expect(warnings).toEqual([]);
    const seen: string[] = [];
    for (const chunk of chunks) {
      expect(chunk.section_path).toEqual(['资产负债表']);
      expect(chunk.chunk_kind).toBe('table');
      expect(chunk.content.startsWith(`${HEADER}\n${SEPARATOR}\n`)).toBe(true);
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);
      seen.push(...chunk.content.split('\n').slice(2));
    }
    expect(seen).toEqual(ROWS);
  });

  it('keeps a small table in one chunk with its surrounding paragraphs when it fits', () => {
    const markdown = ['## 摘要', '', '以下为主要科目。', '', '|a|b|', '|---|---|', '|1|2|', '|3|4|', '', '单位：万元。'].join('\n');
    const { chunks } = chunkTableAware(markdown, OPTIONS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('以下为主要科目。\n\n|a|b|\n|---|---|\n|1|2|\n|3|4|\n\n单位：万元。');
    expect(chunks[0]?.chunk_kind).toBe('text');

    const only = chunkTableAware('## 表\n\n|a|b|\n|---|---|\n|1|2|\n', OPTIONS).chunks;
    expect(only).toHaveLength(1);
    expect(only[0]?.chunk_kind).toBe('table');
    expect(only[0]?.content).toBe('|a|b|\n|---|---|\n|1|2|');
  });

  it('chunks the text around tables like markdown_sections, with the same section_path rules', () => {
    const prose = (label: string): string => `${label}说明。`.repeat(60);
    const textOnly = `# 报告\n\n${prose('前言')}\n\n## 明细\n\n## 说明\n\n${prose('后记')}\n`;
    const withTable = `# 报告\n\n${prose('前言')}\n\n## 明细\n\n${BIG_TABLE}\n\n## 说明\n\n${prose('后记')}\n`;

    const expected = chunkMarkdownSections(textOnly, OPTIONS);
    expect(expected.length).toBeGreaterThan(2);
    const result = chunkTableAware(withTable, OPTIONS).chunks;
    expect(result.filter((chunk) => chunk.chunk_kind === 'text')).toEqual(expected);
    const tables = result.filter((chunk) => chunk.chunk_kind === 'table');
    expect(tables.length).toBeGreaterThan(1);
    expect(tables.every((chunk) => chunk.section_path.join('/') === '报告/明细')).toBe(true);
    expect(chunkTableAware(textOnly, OPTIONS).chunks).toEqual(expected);
  });

  it('gives a row longer than max_tokens its own chunk with the header and warns oversized_table_row', () => {
    const huge = `|超长行|${'很长的单元格内容'.repeat(80)}|x|y|`;
    const rows = [...ROWS.slice(0, 3), huge, ...ROWS.slice(3, 6)];
    const { chunks, warnings } = chunkTableAware(`## 明细\n\n${[HEADER, SEPARATOR, ...rows].join('\n')}\n`, OPTIONS);
    expect(warnings).toEqual(['oversized_table_row']);
    const holder = chunks.filter((chunk) => chunk.content.includes(huge));
    expect(holder).toHaveLength(1);
    expect(holder[0]?.content).toBe(`${HEADER}\n${SEPARATOR}\n${huge}`);
    expect(holder[0]?.chunk_kind).toBe('table');
    const rest = chunks.filter((chunk) => chunk !== holder[0]);
    for (const chunk of rest) expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);
    expect(chunks.flatMap((chunk) => chunk.content.split('\n').slice(2))).toEqual(rows);
  });

  it('repeats the header only on the first piece when the profile switches repeat off, and never repeats a missing header', () => {
    const noRepeat = chunkTableAware(`## 表\n\n${BIG_TABLE}\n`, { ...OPTIONS, repeatTableHeader: false }).chunks;
    expect(noRepeat.length).toBeGreaterThan(2);
    expect(noRepeat[0]?.content.startsWith(`${HEADER}\n${SEPARATOR}`)).toBe(true);
    for (const chunk of noRepeat.slice(1)) expect(chunk.content.includes(HEADER)).toBe(false);

    const bare = ROWS.slice(0, 30).join('\n');
    const headerless = chunkTableAware(`## 表\n\n${bare}\n`, OPTIONS).chunks;
    expect(headerless.length).toBeGreaterThan(1);
    expect(headerless.map((chunk) => chunk.content).join('\n')).toBe(bare);
  });

  it('does not treat pipes inside a code fence as a table', () => {
    const markdown = ['## 代码', '', '```', '|a|b|', '|---|---|', '|1|2|', '```'].join('\n');
    const { chunks } = chunkTableAware(markdown, OPTIONS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_kind).toBe('text');
  });
});
