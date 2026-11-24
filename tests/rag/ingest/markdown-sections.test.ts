import { describe, expect, it } from 'vitest';
import { chunkMarkdownSections, type MarkdownChunkOptions } from '@/lib/rag/ingest/chunkers/markdown-sections';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const OPTIONS: MarkdownChunkOptions = { maxTokens: 120, overlapTokens: 0, minChunkTokens: 0, repeatTableHeader: false };
const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));

describe('markdown section chunker', () => {
  it('builds section_path from the heading stack and pops it on a sibling heading', () => {
    const chunks = chunkMarkdownSections(
      ['Preamble text.', '', '# A', '', 'alpha body', '', '## B', '', 'beta body', '', '## C ##', '', 'gamma body', '', '# D', '', 'delta body'].join('\n'),
      OPTIONS,
    );
    expect(chunks.map((chunk) => chunk.section_path)).toEqual([[], ['A'], ['A', 'B'], ['A', 'C'], ['D']]);
    expect(chunks.map((chunk) => chunk.content)).toEqual(['Preamble text.', 'alpha body', 'beta body', 'gamma body', 'delta body']);
  });

  it('does not treat a hash line inside a code fence as a heading', () => {
    const chunks = chunkMarkdownSections(['# Real', '', '```sh', '# comment line', 'run --now', '```'].join('\n'), OPTIONS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.section_path).toEqual(['Real']);
    expect(chunks[0]?.content).toContain('# comment line');
  });

  it('keeps every chunk within max_tokens on the embedding text and never splits a list item', () => {
    const items = Array.from({ length: 30 }, (_, i) => `- item ${i} ${'alpha beta gamma '.repeat(3).trim()}`);
    const chunks = chunkMarkdownSections(['# List', '', ...items].join('\n'), OPTIONS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);
    for (const item of items) expect(chunks.some((chunk) => chunk.content.includes(item))).toBe(true);
  });

  it('keeps table rows whole, marks table chunks and repeats the header when the profile asks for it', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `| row-${i} | ${'cell '.repeat(6).trim()} | ${i} |`);
    const markdown = ['## Table', '', '| name | note | n |', '| --- | --- | --- |', ...rows].join('\n');

    const plain = chunkMarkdownSections(markdown, OPTIONS);
    expect(plain.length).toBeGreaterThan(1);
    expect(plain.every((chunk) => chunk.chunk_kind === 'table')).toBe(true);
    for (const row of rows) expect(plain.some((chunk) => chunk.content.includes(row))).toBe(true);
    expect(plain.slice(1).some((chunk) => chunk.content.startsWith('| name |'))).toBe(false);

    const repeated = chunkMarkdownSections(markdown, { ...OPTIONS, repeatTableHeader: true });
    for (const chunk of repeated) {
      expect(chunk.content.startsWith('| name | note | n |\n| --- | --- | --- |')).toBe(true);
      expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);
    }
    for (const row of rows) expect(repeated.some((chunk) => chunk.content.includes(row))).toBe(true);
  });

  it('carries overlap units inside a section and never across sections', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} says ${'north south east west '.repeat(2).trim()}.`);
    const markdown = ['# One', '', ...paragraphs.flatMap((p) => [p, '']), '# Two', '', 'Other section text.'].join('\n');
    const chunks = chunkMarkdownSections(markdown, { ...OPTIONS, overlapTokens: 25 });
    const one = chunks.filter((chunk) => chunk.section_path[0] === 'One');
    expect(one.length).toBeGreaterThan(1);
    for (let i = 1; i < one.length; i += 1) {
      const previousLast = (one[i - 1]?.content ?? '').split('\n\n').pop() ?? '';
      expect(one[i]?.content.startsWith(previousLast)).toBe(true);
    }
    expect(chunks[chunks.length - 1]?.content).toBe('Other section text.');
  });

  it('splits an oversized paragraph on sentence boundaries and keeps CJK text unspaced', () => {
    const latin = chunkMarkdownSections(`# L\n\n${'One sentence ends here. '.repeat(60)}`, OPTIONS);
    expect(latin.length).toBeGreaterThan(1);
    for (const chunk of latin) expect(embeddingTokens(chunk)).toBeLessThanOrEqual(OPTIONS.maxTokens);

    const cjk = chunkMarkdownSections(`# 章\n\n${'这是一个测试句子。'.repeat(80)}`, OPTIONS);
    expect(cjk.length).toBeGreaterThan(1);
    expect(cjk.every((chunk) => !chunk.content.includes(' '))).toBe(true);
    expect(cjk.map((chunk) => chunk.content).join('')).toBe('这是一个测试句子。'.repeat(80));
  });

  it('returns no chunk for a document with headings only', () => {
    expect(chunkMarkdownSections('# Only\n\n## Headings\n', OPTIONS)).toEqual([]);
  });
});
