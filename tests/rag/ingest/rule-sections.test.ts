import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarkdownChunkOptions } from '@/lib/rag/ingest/chunkers/markdown-sections';
import { carryTableHeaders } from '@/lib/rag/ingest/chunkers/markdown-tables';
import {
  chunkRuleSections,
  scanRuleSections,
  type ResolvedSectionRules,
} from '@/lib/rag/ingest/chunkers/rule-sections';
import { buildEmbeddingText } from '@/lib/rag/ingest/text/embedding-text';
import { countTokens } from '@/lib/rag/ingest/text/tokens';

const OPTIONS: MarkdownChunkOptions = { maxTokens: 400, overlapTokens: 0, minChunkTokens: 0, repeatTableHeader: true };

type Hit = { name: string; level: number; restart?: boolean };

function rules(hits: Record<string, Hit>, extra: Partial<ResolvedSectionRules> = {}): ResolvedSectionRules {
  const resolved: ResolvedSectionRules['hits'] = {};
  for (const [key, hit] of Object.entries(hits)) resolved[key] = { name: hit.name, level: hit.level, restart: hit.restart ?? false };
  return { rule_set_id: '00000000-0000-4000-8000-000000000001', version: 1, skip_toc: true, toc_min_run: 3, hits: resolved, ...extra };
}

const doc = (...lines: string[]): string => lines.join('\n');
const paths = (result: { chunks: Array<{ section_path: string[] }> }): string[][] => result.chunks.map((chunk) => chunk.section_path);
const embeddingTokens = (chunk: { section_path: string[]; content: string }): number =>
  countTokens(buildEmbeddingText({ section_path: chunk.section_path, content: chunk.content }));

const BASIC_HITS = {
  '1 Alpha': { name: 'Alpha', level: 1 },
  '2 Beta': { name: 'Beta', level: 1 },
  '2.1 Gamma': { name: 'Gamma', level: 2 },
};

const BASIC = doc(
  'Plenk varo misu.',
  '',
  '1 Alpha',
  'Zorvik plent masu tarel.',
  '',
  '2 Beta',
  'Quorel defti nanu.',
  '## Unlisted heading',
  'Vesti pram olu.',
  '',
  '2.1 Gamma',
  'Tumbra kelo vint.',
);

describe('rule_sections: allowed headings only', () => {
  it('opens a section only at a hit line, with the hit name and level, and keeps a non-hit Markdown heading as body text', () => {
    const result = chunkRuleSections(BASIC, { ...OPTIONS, rules: rules(BASIC_HITS) });
    expect(paths(result)).toEqual([[], ['Alpha'], ['Beta'], ['Beta', 'Gamma']]);
    expect(result.chunks[0]?.content).toBe('Plenk varo misu.');
    expect(result.chunks[2]?.content).toContain('## Unlisted heading');
    expect(result.chunks[2]?.content).toContain('Vesti pram olu.');
    expect(result.warnings).toEqual([]);
    for (const chunk of result.chunks) {
      expect(chunk.page_start).toBeNull();
      expect(chunk.page_end).toBeNull();
      expect(chunk.metadata).toEqual({});
    }
  });

  it('keys a hit by trimmed text, so a Markdown heading line or an indented line can be a hit', () => {
    const markdown = doc('# 1 Alpha', 'Zorvik plent.', '   2 Beta   ', 'Quorel defti.');
    const result = chunkRuleSections(markdown, {
      ...OPTIONS,
      rules: rules({ '# 1 Alpha': { name: 'Alpha', level: 1 }, '2 Beta': { name: 'Beta', level: 1 } }),
    });
    expect(paths(result)).toEqual([['Alpha'], ['Beta']]);
  });

  it('closes every open level at or below the level of a new hit', () => {
    const markdown = doc('1 Alpha', 'a.', '1.1 Sub', 'b.', '1.1.1 Deep', 'c.', '2 Beta', 'd.', '2.1 Sub', 'e.');
    const result = chunkRuleSections(markdown, {
      ...OPTIONS,
      rules: rules({
        '1 Alpha': { name: 'Alpha', level: 1 },
        '1.1 Sub': { name: 'SubOne', level: 2 },
        '1.1.1 Deep': { name: 'Deep', level: 3 },
        '2 Beta': { name: 'Beta', level: 1 },
        '2.1 Sub': { name: 'SubTwo', level: 2 },
      }),
    });
    expect(paths(result)).toEqual([['Alpha'], ['Alpha', 'SubOne'], ['Alpha', 'SubOne', 'Deep'], ['Beta'], ['Beta', 'SubTwo']]);
  });

  it('never treats a fenced line or a table row as a heading, even when its trimmed text is a hit key', () => {
    const markdown = doc('1 Alpha', 'Zorvik.', '```', '2 Beta', '```', '| 2 Beta |', '| --- |', '| x |', '', '3 Gamma', 'Tumbra.');
    const result = chunkRuleSections(markdown, {
      ...OPTIONS,
      rules: rules({
        '1 Alpha': { name: 'Alpha', level: 1 },
        '2 Beta': { name: 'Beta', level: 1 },
        '| 2 Beta |': { name: 'Row', level: 1 },
        '3 Gamma': { name: 'Gamma', level: 1 },
      }),
    });
    expect([...new Set(paths(result).map((entry) => entry.join('/')))]).toEqual(['Alpha', 'Gamma']);
    const alpha = result.chunks.filter((chunk) => chunk.section_path[0] === 'Alpha').map((chunk) => chunk.content).join('\n');
    expect(alpha).toContain('2 Beta');
    expect(alpha).toContain('| 2 Beta |');
  });

  it('ignores inherited object keys: a line named like a prototype member is body text', () => {
    const markdown = doc('1 Alpha', 'constructor', 'toString', '__proto__', 'hasOwnProperty');
    const scan = scanRuleSections(markdown, rules({ '1 Alpha': { name: 'Alpha', level: 1 } }));
    expect(scan.events.map((event) => event.text)).toEqual(['1 Alpha']);
    const result = chunkRuleSections(markdown, { ...OPTIONS, rules: rules({ '1 Alpha': { name: 'Alpha', level: 1 } }) });
    expect(paths(result)).toEqual([['Alpha']]);
    expect(result.chunks[0]?.content).toContain('constructor');
  });

  it('returns the whole document as one section with a warning when the hit map is empty or absent', () => {
    for (const data of [rules({}), null, undefined]) {
      const result = chunkRuleSections(BASIC, { ...OPTIONS, rules: data });
      expect(paths(result)).toEqual([[]]);
      expect(result.chunks[0]?.content).toContain('2.1 Gamma');
      expect(result.warnings).toEqual(['rule_sections_without_rules']);
    }
  });
});

const VARIANT_HITS = {
  '# Part North': { name: 'Part', level: 1, restart: true },
  '# Part South': { name: 'Part', level: 1, restart: true },
  'Part North': { name: 'Part', level: 1, restart: true },
  'Part South': { name: 'Part', level: 1, restart: true },
  '1 Alpha': { name: 'Alpha', level: 2 },
  '2 Beta': { name: 'Beta', level: 2 },
};

const VARIANTS = doc(
  'Prelude plenk varo.',
  '',
  '# Part North',
  'Opening norla.',
  '1 Alpha',
  'Zorvik north.',
  '2 Beta',
  'Quorel north.',
  '',
  '# Part South',
  '1 Alpha',
  'Zorvik south.',
  '2 Beta',
  'Quorel south.',
);

describe('rule_sections: variants', () => {
  it('cuts a document at each restart occurrence and puts the variant label first in every path from the first occurrence on', () => {
    const result = chunkRuleSections(VARIANTS, { ...OPTIONS, rules: rules(VARIANT_HITS) });
    expect(paths(result)).toEqual([
      [],
      ['Part North', 'Part'],
      ['Part North', 'Part', 'Alpha'],
      ['Part North', 'Part', 'Beta'],
      ['Part South', 'Part', 'Alpha'],
      ['Part South', 'Part', 'Beta'],
    ]);
    expect(result.chunks[0]?.metadata).toEqual({});
    expect(result.chunks.slice(1, 4).map((chunk) => chunk.metadata)).toEqual(
      Array(3).fill({ variant_index: 1, variant_label: 'Part North' }),
    );
    expect(result.chunks.slice(4).map((chunk) => chunk.metadata)).toEqual(Array(2).fill({ variant_index: 2, variant_label: 'Part South' }));
    expect(result.chunks.find((chunk) => chunk.content.includes('Zorvik south'))?.section_path).toEqual(['Part South', 'Part', 'Alpha']);
  });

  it('resets the heading stack at a restart occurrence, so no heading of the previous variant stays open', () => {
    const markdown = doc('Part North', '1 Alpha', 'x.', '1.1 Deep', 'y.', 'Part South', 'z.');
    const result = chunkRuleSections(markdown, {
      ...OPTIONS,
      rules: rules({
        'Part North': { name: 'Part', level: 3, restart: true },
        'Part South': { name: 'Part', level: 3, restart: true },
        '1 Alpha': { name: 'Alpha', level: 1 },
        '1.1 Deep': { name: 'Deep', level: 2 },
      }),
    });
    expect(paths(result)).toEqual([['Part North', 'Alpha'], ['Part North', 'Alpha', 'Deep'], ['Part South', 'Part']]);
  });

  it('adds no variant when the restart heading occurs once or never', () => {
    const once = doc('Part North', '1 Alpha', 'Zorvik.', '2 Beta', 'Quorel.');
    const result = chunkRuleSections(once, { ...OPTIONS, rules: rules(VARIANT_HITS) });
    expect(paths(result)).toEqual([['Part', 'Alpha'], ['Part', 'Beta']]);
    for (const chunk of result.chunks) expect(chunk.metadata).toEqual({});
    const never = chunkRuleSections(doc('1 Alpha', 'Zorvik.'), { ...OPTIONS, rules: rules(VARIANT_HITS) });
    expect(paths(never)).toEqual([['Alpha']]);
    expect(never.chunks[0]?.metadata).toEqual({});
  });

  it('cuts a long label to 80 characters and numbers every label of a document when two would be equal', () => {
    const long = `Part ${'w'.repeat(100)}`;
    const cut = chunkRuleSections(doc(long, 'a.', 'Part South', 'b.'), {
      ...OPTIONS,
      rules: rules({ [long]: { name: 'Part', level: 1, restart: true }, 'Part South': { name: 'Part', level: 1, restart: true } }),
    });
    expect(cut.chunks[0]?.section_path[0]).toBe(long.slice(0, 80));
    expect(cut.chunks[0]?.metadata.variant_label).toBe(long.slice(0, 80));

    const same = chunkRuleSections(doc('# Part Same', 'a.', 'Part Same', 'b.', 'Part Other', 'c.'), {
      ...OPTIONS,
      rules: rules({
        '# Part Same': { name: 'Part', level: 1, restart: true },
        'Part Same': { name: 'Part', level: 1, restart: true },
        'Part Other': { name: 'Part', level: 1, restart: true },
      }),
    });
    expect(same.chunks.map((chunk) => chunk.metadata.variant_label)).toEqual(['Part Same 1', 'Part Same 2', 'Part Other 3']);
    expect(same.chunks.map((chunk) => chunk.section_path[0])).toEqual(['Part Same 1', 'Part Same 2', 'Part Other 3']);
  });

  it('reports the walk as data: events with names, levels, restart flags and variant indexes, and the sections', () => {
    const scan = scanRuleSections(VARIANTS, rules(VARIANT_HITS));
    expect(scan.events.map((event) => [event.text, event.name, event.level, event.restart, event.variantIndex, event.skippedAsToc])).toEqual([
      ['# Part North', 'Part', 1, true, 1, false],
      ['1 Alpha', 'Alpha', 2, false, 1, false],
      ['2 Beta', 'Beta', 2, false, 1, false],
      ['# Part South', 'Part', 1, true, 2, false],
      ['1 Alpha', 'Alpha', 2, false, 2, false],
      ['2 Beta', 'Beta', 2, false, 2, false],
    ]);
    expect(scan.events[0]?.lineIndex).toBe(2);
    expect(scan.variants).toEqual([
      { index: 1, label: 'Part North', lineIndex: 2 },
      { index: 2, label: 'Part South', lineIndex: 9 },
    ]);
    expect(scan.sections.map((section) => [section.path, section.heading, section.variantIndex, section.variantLabel])).toEqual([
      [[], null, null, null],
      [['Part North', 'Part'], 0, 1, 'Part North'],
      [['Part North', 'Part', 'Alpha'], 1, 1, 'Part North'],
      [['Part North', 'Part', 'Beta'], 2, 1, 'Part North'],
      [['Part South', 'Part'], 3, 2, 'Part South'],
      [['Part South', 'Part', 'Alpha'], 4, 2, 'Part South'],
      [['Part South', 'Part', 'Beta'], 5, 2, 'Part South'],
    ]);
    expect(scan.sections[2]?.lines).toEqual(['Zorvik north.']);
  });
});

const TOC_HITS = {
  '1 Alpha': { name: 'Alpha', level: 1 },
  '2 Beta': { name: 'Beta', level: 1 },
  '3 Gamma': { name: 'Gamma', level: 1 },
};

const TOC = doc('Contents', '', '1 Alpha', '2 Beta', '', '3 Gamma', '1 Alpha', 'Zorvik plent.', '2 Beta', 'Quorel defti.', '3 Gamma', 'Tumbra kelo.');

describe('rule_sections: table-of-contents runs', () => {
  it('skips a run of at least toc_min_run hit lines except its last line, which heads the body after it', () => {
    const result = chunkRuleSections(TOC, { ...OPTIONS, rules: rules(TOC_HITS) });
    expect(paths(result)).toEqual([[], ['Alpha'], ['Beta'], ['Gamma']]);
    expect(result.chunks[0]?.content).toBe('Contents');
    expect(result.chunks[1]?.content).toBe('Zorvik plent.');
    const scan = scanRuleSections(TOC, rules(TOC_HITS));
    expect(scan.events.map((event) => event.skippedAsToc)).toEqual([true, true, true, false, false, false]);
  });

  it('keeps a run shorter than toc_min_run, every run when skip_toc is off, and a run whose levels deepen at every step', () => {
    const short = chunkRuleSections(TOC, { ...OPTIONS, rules: rules(TOC_HITS, { toc_min_run: 5 }) });
    expect(short.chunks.map((chunk) => chunk.content)).toEqual(['Contents', 'Zorvik plent.', 'Quorel defti.', 'Tumbra kelo.']);
    expect(scanRuleSections(TOC, rules(TOC_HITS, { toc_min_run: 5 })).events.some((event) => event.skippedAsToc)).toBe(false);
    expect(scanRuleSections(TOC, rules(TOC_HITS, { skip_toc: false })).events.some((event) => event.skippedAsToc)).toBe(false);

    const chain = doc('1 Alpha', '1.1 Sub', '1.1.1 Deep', 'Zorvik.');
    const chainHits = {
      '1 Alpha': { name: 'Alpha', level: 1 },
      '1.1 Sub': { name: 'Sub', level: 2 },
      '1.1.1 Deep': { name: 'Deep', level: 3 },
    };
    expect(scanRuleSections(chain, rules(chainHits)).events.some((event) => event.skippedAsToc)).toBe(false);
    expect(paths(chunkRuleSections(chain, { ...OPTIONS, rules: rules(chainHits) }))).toEqual([['Alpha', 'Sub', 'Deep']]);
  });

  it('does not count a restart hit inside a skipped run as a variant occurrence', () => {
    const hits = { ...VARIANT_HITS, '3 Gamma': { name: 'Gamma', level: 2 } };
    const markdown = doc('Part North', 'Part South', '1 Alpha', 'Part North', 'Zorvik.', '2 Beta', 'Quorel.');
    const result = chunkRuleSections(markdown, { ...OPTIONS, rules: rules(hits) });
    expect(paths(result)).toEqual([['Part'], ['Part', 'Beta']]);
    for (const chunk of result.chunks) expect(chunk.metadata).toEqual({});
  });
});

describe('rule_sections: packing', () => {
  it('packs every section with the section packers: an over-budget section splits under one path, a table is cut by whole rows', () => {
    const sentences = Array.from({ length: 80 }, (_, index) => `Sentence ${index} zorvik plent masu tarel vesti pram.`).join(' ');
    const header = '|Key|Value|';
    const rows = Array.from({ length: 60 }, (_, index) => `|k${index}|v${index} plent masu|`);
    const markdown = doc('1 Alpha', sentences, '', '2 Beta', header, '|---|---|', ...rows);
    const options = { ...OPTIONS, maxTokens: 120 };
    const result = chunkRuleSections(markdown, { ...options, rules: rules(TOC_HITS) });
    const alpha = result.chunks.filter((chunk) => chunk.section_path.join('/') === 'Alpha');
    const beta = result.chunks.filter((chunk) => chunk.section_path.join('/') === 'Beta');
    expect(alpha.length).toBeGreaterThan(1);
    expect(beta.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const chunk of result.chunks) expect(embeddingTokens(chunk)).toBeLessThanOrEqual(options.maxTokens);
    for (const chunk of beta) {
      expect(chunk.chunk_kind).toBe('table');
      expect(chunk.content.startsWith(`${header}\n|---|---|\n`)).toBe(true);
      seen.push(...chunk.content.split('\n').slice(2));
    }
    expect(seen).toEqual(rows);
  });

  it('gives the same sections and paths after the table-header carry as before it', () => {
    const markdown = doc('1 Alpha', '| Key | Count |', '| --- | --- |', '| 1 | 10 |', '| 2 | 20 |', '', '| 3 | 30 |', '| 4 | 40 |', '', '2 Beta', 'Quorel.');
    const carry = carryTableHeaders(markdown);
    expect(carry.carried).toBe(1);
    const data = rules(TOC_HITS);
    expect(paths(chunkRuleSections(carry.markdown, { ...OPTIONS, rules: data }))).toEqual(paths(chunkRuleSections(markdown, { ...OPTIONS, rules: data })));
    expect(scanRuleSections(carry.markdown, data).sections.map((section) => section.path)).toEqual(
      scanRuleSections(markdown, data).sections.map((section) => section.path),
    );
  });
});

describe('rule_sections: purity', () => {
  it('returns deeply equal output for equal input and does not mutate the rule data', () => {
    const data = rules(VARIANT_HITS);
    const snapshot = JSON.parse(JSON.stringify(data));
    Object.freeze(data);
    Object.freeze(data.hits);
    for (const hit of Object.values(data.hits)) Object.freeze(hit);
    const first = chunkRuleSections(VARIANTS, { ...OPTIONS, rules: data });
    const second = chunkRuleSections(VARIANTS, { ...OPTIONS, rules: data });
    expect(first).toEqual(second);
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(scanRuleSections(VARIANTS, data)).toEqual(scanRuleSections(VARIANTS, data));
    expect(data).toEqual(snapshot);
  });

  it('builds no pattern from data and imports no pattern module', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/lib/rag/ingest/chunkers/rule-sections.ts'), 'utf8');
    expect(source).not.toMatch(/RegExp\(/);
    expect(source).not.toMatch(/from '@\/lib\/rag\/(patterns|identifiers)/);
    expect(source).not.toMatch(/console\./);
  });
});
