import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoilerplateReportSchema, type BoilerplateRulesConfig } from '@/lib/rag-eval/contracts.generated';
import {
  CLEANER_VERSION,
  cleanBoilerplate,
  lineDigest,
  removalTextMap,
  replayRemoval,
} from '@/lib/rag/ingest/prepare/boilerplate';
import { readPageLines, type PageLines } from '@/lib/rag/ingest/prepare/page-lines';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const config: BoilerplateRulesConfig = {
  schema_version: 1,
  rules_version: 4,
  page_share: 0.6,
  edge_lines: 2,
  max_line_tokens: 12,
  min_pages: 3,
  fragment_max_length: 12,
  fragment_page_share: 0.5,
  review_share: 0.2,
};

const OPENING = 'alpha bravo opening';
const closing = (n: number): string => `sheet ${n} of the set`;
const body = (page: number, i: number): string => `body text ${'xyz'.repeat(i + 1)} on leaf ${'abcdefghij'.charAt(page - 1)}`;

function buildPages(count: number, options: { opening?: boolean; closing?: boolean; bodyLines?: number } = {}): string[][] {
  const { opening = true, closing: withClosing = true, bodyLines = 4 } = options;
  return Array.from({ length: count }, (_, p) => {
    const lines: string[] = [];
    if (opening) lines.push(OPENING);
    for (let i = 0; i < bodyLines; i += 1) lines.push(body(p + 1, i));
    if (withClosing) lines.push(closing(p + 1));
    return lines;
  });
}

const toMarkdown = (pages: string[][]): string => pages.map((lines) => lines.join('\n\n')).join('\n\n');
const toPageLines = (pages: string[][]): PageLines =>
  readPageLines({ pages: pages.map((lines, i) => ({ page: i + 1, text: lines.join('\n') })) }) as PageLines;
const nonBlank = (markdown: string): string[] => markdown.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');

describe('cleanBoilerplate: detect', () => {
  it('removes a shared opening line and a numbered closing line and nothing else', () => {
    const pages = buildPages(6);
    const markdown = toMarkdown(pages);
    const result = cleanBoilerplate({ markdown, pageLines: toPageLines(pages), mode: 'detect', config });
    const expected = pages.flatMap((lines) => lines.filter((line) => line !== OPENING && !line.startsWith('sheet ')));
    expect(nonBlank(result.markdown)).toEqual(expected);
    expect(result.markdown).toBe(toMarkdown(pages.map((lines) => lines.filter((l) => l !== OPENING && !l.startsWith('sheet ')))));
    expect(result.report.lines_removed).toBe(12);
    expect(result.removal.keys).toHaveLength(2);
    expect(result.removal.lineDigests).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps a line that repeats on every page away from the edges', () => {
    const middle = 'shared middle remark';
    const pages = buildPages(6, { bodyLines: 6 }).map((lines) => {
      const copy = [...lines];
      copy.splice(3, 0, middle);
      return copy;
    });
    const result = cleanBoilerplate({ markdown: toMarkdown(pages), pageLines: toPageLines(pages), mode: 'detect', config });
    expect(nonBlank(result.markdown).filter((line) => line === middle)).toHaveLength(6);
  });

  it('keeps a repeated edge line longer than the token limit', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ');
    expect(countTokens(long)).toBeGreaterThan(config.max_line_tokens);
    const pages = buildPages(6, { opening: false }).map((lines) => [long, ...lines]);
    const result = cleanBoilerplate({ markdown: toMarkdown(pages), pageLines: toPageLines(pages), mode: 'detect', config });
    expect(nonBlank(result.markdown).filter((line) => line === long)).toHaveLength(6);
  });

  it('removes nothing below the minimum page count', () => {
    for (const count of [1, 2]) {
      const pages = buildPages(count);
      const markdown = toMarkdown(pages);
      const result = cleanBoilerplate({
        markdown,
        pageLines: toPageLines(pages),
        mode: 'both',
        config,
        fragmentRules: [{ max_length: 40, min_page_share: 0.1 }],
      });
      expect(result.markdown).toBe(markdown);
      expect(result.report.lines_removed).toBe(0);
    }
  });

  it('ignores line hits in detect mode', () => {
    const pages = buildPages(4, { opening: false, closing: false });
    const markdown = toMarkdown(pages);
    const result = cleanBoilerplate({
      markdown,
      pageLines: toPageLines(pages),
      mode: 'detect',
      config,
      lineHits: new Set([body(1, 0)]),
    });
    expect(result.markdown).toBe(markdown);
  });
});

describe('cleanBoilerplate: fragment rule', () => {
  it('removes a short stand-alone fragment repeated on pages and keeps it inside a longer line', () => {
    const pages = buildPages(4, { opening: false, closing: false }).map((lines, i) => {
      const copy = [...lines];
      copy.splice(2, 0, 'qz mark');
      if (i === 0) copy.push('a longer line that holds qz mark inside');
      return copy;
    });
    const markdown = toMarkdown(pages);
    const pageLines = toPageLines(pages);
    const off = cleanBoilerplate({ markdown, pageLines, mode: 'rules', config });
    expect(off.markdown).toBe(markdown);
    const result = cleanBoilerplate({
      markdown,
      pageLines,
      mode: 'rules',
      config,
      fragmentRules: [{ max_length: 10, min_page_share: 0.5 }],
    });
    const lines = nonBlank(result.markdown);
    expect(lines).not.toContain('qz mark');
    expect(lines).toContain('a longer line that holds qz mark inside');
    expect(result.report.lines_removed).toBe(4);
  });

  it('uses the smaller length and the larger share of rule and config', () => {
    const pages = buildPages(4, { opening: false, closing: false }).map((lines, i) => (i < 2 ? ['qz mark', ...lines] : lines));
    const markdown = toMarkdown(pages);
    const pageLines = toPageLines(pages);
    const lowShare = cleanBoilerplate({ markdown, pageLines, mode: 'rules', config: { ...config, fragment_page_share: 0.75 }, fragmentRules: [{ max_length: 10, min_page_share: 0.25 }] });
    expect(lowShare.report.lines_removed).toBe(0);
    const shortLimit = cleanBoilerplate({ markdown, pageLines, mode: 'rules', config: { ...config, fragment_max_length: 4 }, fragmentRules: [{ max_length: 40, min_page_share: 0.5 }] });
    expect(shortLimit.report.lines_removed).toBe(0);
    const both = cleanBoilerplate({ markdown, pageLines, mode: 'both', config, fragmentRules: [{ max_length: 10, min_page_share: 0.5 }] });
    expect(both.report.lines_removed).toBe(2);
  });
});

describe('cleanBoilerplate: line hits and missing pages', () => {
  it('removes hit lines in rules mode and stores digests only', () => {
    const markdown = ['first keep', 'hit target line', 'second keep', '  hit target line  '].join('\n');
    const result = cleanBoilerplate({ markdown, pageLines: null, mode: 'rules', config, lineHits: ['hit target line', 'never present'] });
    expect(result.markdown).toBe('first keep\nsecond keep');
    expect(result.removal).toEqual({ keys: [], lineDigests: [lineDigest('hit target line')] });
    expect(JSON.stringify(result.removal)).not.toContain('hit target');
    expect(result.warnings).toEqual([]);
  });

  it('warns once when page structure is missing and still applies line hits', () => {
    const markdown = 'keep one\nhit target line\nkeep two';
    const result = cleanBoilerplate({
      markdown,
      pageLines: null,
      mode: 'both',
      config,
      lineHits: new Set(['hit target line']),
      fragmentRules: [{ max_length: 10, min_page_share: 0.5 }],
    });
    expect(result.warnings).toEqual(['boilerplate_pages_unavailable']);
    expect(result.markdown).toBe('keep one\nkeep two');
    expect(cleanBoilerplate({ markdown, pageLines: null, mode: 'detect', config }).warnings).toEqual(['boilerplate_pages_unavailable']);
  });

  it('computes lineDigest from the trimmed text', () => {
    const expected = createHash('sha256').update('some line', 'utf8').digest('hex').slice(0, 16);
    expect(lineDigest('  some line ')).toBe(expected);
    expect(lineDigest('some line')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('cleanBoilerplate: protected lines', () => {
  const pagesWith = (extra: string[]): string[][] => buildPages(6, { opening: false, closing: false }).map((lines) => [OPENING, ...lines, ...extra]);

  it('keeps fenced blocks and their fence lines', () => {
    const markdown = ['```', OPENING, '```', 'plain', OPENING, '~~~text', 'hit target line', '~~~'].join('\n');
    const pages = pagesWith([]);
    const result = cleanBoilerplate({ markdown, pageLines: toPageLines(pages), mode: 'both', config, lineHits: ['hit target line', '```', '~~~'] });
    expect(result.markdown).toBe(['```', OPENING, '```', 'plain', '~~~text', 'hit target line', '~~~'].join('\n'));
  });

  it('keeps table rows', () => {
    const row = `| ${OPENING} |`;
    const markdown = ['| head |', '| --- |', row, OPENING].join('\n');
    const result = cleanBoilerplate({ markdown, pageLines: toPageLines(pagesWith([])), mode: 'both', config, lineHits: [row] });
    expect(result.markdown).toBe(['| head |', '| --- |', row].join('\n'));
  });

  it('keeps headings with a title', () => {
    const heading = `## ${OPENING}`;
    const markdown = [heading, 'text', OPENING].join('\n');
    const result = cleanBoilerplate({ markdown, pageLines: toPageLines(pagesWith([])), mode: 'both', config, lineHits: [heading] });
    expect(result.markdown).toBe([heading, 'text'].join('\n'));
  });

  it('keeps lines in the protected set', () => {
    const markdown = ['text', OPENING, 'more'].join('\n');
    const result = cleanBoilerplate({ markdown, pageLines: toPageLines(pagesWith([])), mode: 'detect', config, protectedLines: [OPENING] });
    expect(result.markdown).toBe(markdown);
    expect(result.removal).toEqual({ keys: [], lineDigests: [] });
  });
});

describe('cleanBoilerplate: output shape', () => {
  it('deletes one of two blank lines around a removed line', () => {
    const result = cleanBoilerplate({ markdown: 'one\n\nhit target line\n\ntwo', pageLines: null, mode: 'rules', config, lineHits: ['hit target line'] });
    expect(result.markdown).toBe('one\n\ntwo');
  });

  it('returns the input string itself when nothing is removed', () => {
    const markdown = 'one\n\ntwo\n';
    const result = cleanBoilerplate({ markdown, pageLines: null, mode: 'rules', config });
    expect(result.markdown).toBe(markdown);
    expect(result.report.lines_removed).toBe(0);
    expect(result.report.tokens_removed).toBe(0);
    expect(result.report.share).toBe(0);
  });

  it('keeps CRLF line breaks on surviving lines', () => {
    const result = cleanBoilerplate({ markdown: 'one\r\nhit target line\r\ntwo\r\n', pageLines: null, mode: 'rules', config, lineHits: ['hit target line'] });
    expect(result.markdown).toBe('one\r\ntwo\r\n');
  });

  it('reports counts with the generated contract and a separate review verdict', () => {
    const markdown = 'one\nhit target line\ntwo';
    const result = cleanBoilerplate({ markdown, pageLines: null, mode: 'rules', config, lineHits: ['hit target line'] });
    expect(BoilerplateReportSchema.parse(result.report)).toEqual(result.report);
    expect(Object.keys(result.report).sort()).toEqual(['cleaner_version', 'lines_removed', 'rules_version', 'share', 'tokens_removed']);
    expect(result.report.cleaner_version).toBe(CLEANER_VERSION);
    expect(result.report.rules_version).toBe(config.rules_version);
    expect(result.report.tokens_removed).toBe(countTokens('hit target line'));
    const share = Math.round((countTokens('hit target line') / countTokens(markdown)) * 10000) / 10000;
    expect(result.report.share).toBe(share);
    expect(result.aboveReviewShare).toBe(share > config.review_share);
    expect(cleanBoilerplate({ markdown, pageLines: null, mode: 'rules', config: { ...config, review_share: 0.99 }, lineHits: ['hit target line'] }).aboveReviewShare).toBe(false);
    expect(cleanBoilerplate({ markdown: '', pageLines: null, mode: 'rules', config }).report.share).toBe(0);
  });

  it('never throws on unusual strings', () => {
    const odd = ['', '\uD800 lone', '<|endoftext|>', '```', '\r\r\n\n', '|', '#', '#'.repeat(7), '\u0000​'];
    for (const markdown of odd) {
      expect(() =>
        cleanBoilerplate({ markdown, pageLines: null, mode: 'both', config, lineHits: [markdown, '<|endoftext|>'] }),
      ).not.toThrow();
    }
  });

  it('builds no expression from input', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../src/lib/rag/ingest/prepare/boilerplate.ts'), 'utf8');
    expect(source).not.toMatch(/RegExp\(/);
    expect(source).not.toMatch(/from '[^']*(worker|pattern)[^']*'/);
  });
});

describe('determinism and replay', () => {
  const pages = buildPages(6).map((lines, i) => (i % 2 === 0 ? [...lines, 'hit target line'] : lines));
  const markdown = toMarkdown(pages);
  const input = {
    markdown,
    pageLines: toPageLines(pages),
    mode: 'both' as const,
    config,
    lineHits: ['hit target line'],
    fragmentRules: [{ max_length: 12, min_page_share: 0.5 }],
    protectedLines: [body(2, 1)],
  };

  it('gives equal output for equal input', () => {
    expect(cleanBoilerplate(input)).toEqual(cleanBoilerplate(input));
  });

  it('replays the removal byte for byte with the same report', () => {
    const first = cleanBoilerplate(input);
    expect(first.report.lines_removed).toBeGreaterThan(0);
    const replay = replayRemoval(markdown, first.removal, input.protectedLines, config);
    expect(replay.markdown).toBe(first.markdown);
    expect(replay.report).toEqual(first.report);
    const again = replayRemoval(first.markdown, first.removal, input.protectedLines, config);
    expect(again.markdown).toBe(first.markdown);
    expect(again.report.lines_removed).toBe(0);
  });

  it('applies the same removal to any text through the text map', () => {
    const first = cleanBoilerplate(input);
    const map = removalTextMap(first.removal, input.protectedLines);
    expect(map(markdown)).toBe(first.markdown);
    expect(map('untouched chunk text')).toBe('untouched chunk text');
    expect(map(OPENING)).toBe('');
    expect(map(`${body(1, 0)}\n${closing(9)}`)).toBe(body(1, 0));
    expect(map(`${body(1, 0)}\n${closing(9)}\n`)).toBe(`${body(1, 0)}\n`);
    expect(map('hit target line')).toBe('');
  });
});
