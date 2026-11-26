import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ResolvedSectionRules } from '@/lib/rag/ingest/chunkers/rule-sections';
import {
  HEADING_PATTERN_ID_PREFIX,
  SECTION_HITS_CAP,
  checkSectionRules,
  headingCandidates,
  headingPatterns,
  hitsOverCap,
  resolveSectionHits,
  resolvedSectionRules,
} from '@/lib/rag/ingest/prepare/section-hits';
import type { LoadedSectionRuleSet } from '@/lib/rag/ingest/rules/load';

/**
 * Plan 03.3-12 (D-11, D-17, D-19): heading hits from the worker's spans and the conformance check over the rule-section walk. Rule sets
 * and documents are invented: numbered heading lines with one-word names, shape-only patterns.
 */

const RULE_SET_ID = '44444444-4444-4444-8444-444444444444';

function ruleSet(partial: Partial<LoadedSectionRuleSet> = {}): LoadedSectionRuleSet {
  return {
    id: RULE_SET_ID,
    version: 3,
    docType: 'general',
    source: null,
    headings: [
      { pattern: '^Part [0-9]+', flags: 'u', name: 'Part', level: 1, required: true, restart: true },
      { pattern: '^[0-9]+\\. Alpha', flags: 'u', name: 'Alpha', level: 2, required: true, restart: false },
      { pattern: '^[0-9]+\\. Bravo', flags: 'u', name: 'Bravo', level: 2, required: false, restart: false },
      { pattern: '^[0-9]+\\.', flags: 'u', name: 'Item', level: 2, required: false, restart: false },
    ],
    requireIncreasingNumbers: true,
    skipToc: true,
    tocMinRun: 3,
    ...partial,
  };
}

const PART = { name: 'Part', level: 1, restart: true };
const ALPHA = { name: 'Alpha', level: 2, restart: false };
const BRAVO = { name: 'Bravo', level: 2, restart: false };

/** Hit data the way resolveSectionHits builds it: every line whose text names a heading of the rule set. */
function rulesFor(markdown: string, set: LoadedSectionRuleSet = ruleSet()): ResolvedSectionRules {
  const hits: ResolvedSectionRules['hits'] = {};
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const bare = line.replace(/^#{1,6}\s+/, '');
    if (/^Part [0-9]+/.test(bare)) hits[line] = PART;
    else if (/^[0-9]+\. Alpha/.test(bare)) hits[line] = ALPHA;
    else if (/^[0-9]+\. Bravo/.test(bare)) hits[line] = BRAVO;
  }
  return resolvedSectionRules(set, hits);
}

const part = (n: number, entries: string[]) => [`## Part ${n}`, '', ...entries.flatMap((entry) => [entry, '', `Body text under ${entry} in part ${n}.`, ''])];

describe('headingCandidates and headingPatterns', () => {
  test('one candidate per distinct trimmed line, heading marks removed from the matched text, never fenced lines, table rows or over-long lines', () => {
    const long = `1. Alpha ${'x'.repeat(250)}`;
    const markdown = ['## Part 1', '  1. Alpha  ', '```', '2. Bravo', '```', '| 3. Bravo | cell |', '|---|---|', long, '', '1. Alpha', 'Part 1'].join('\n');
    expect(headingCandidates(markdown)).toEqual([
      { key: '## Part 1', text: 'Part 1' },
      { key: '1. Alpha', text: '1. Alpha' },
      { key: 'Part 1', text: 'Part 1' },
    ]);
  });

  test('heading patterns keep rule-set order with fixed ids and the heading kind', () => {
    const entries = headingPatterns(ruleSet());
    expect(entries.map((entry) => entry.id)).toEqual(['h:0', 'h:1', 'h:2', 'h:3']);
    expect(entries.every((entry) => entry.id.startsWith(HEADING_PATTERN_ID_PREFIX) && entry.kind === 'heading')).toBe(true);
    expect(entries[1]).toEqual({ id: 'h:1', kind: 'heading', pattern: '^[0-9]+\\. Alpha', flags: 'u' });
  });
});

describe('resolveSectionHits', () => {
  const candidates = [
    { input: 0, key: '## Part 1' },
    { input: 0, key: 'Part 1' },
    { input: 1, key: '1. Alpha' },
    { input: 2, key: 'Note 1. Alpha' },
  ];

  test('the first heading pattern in rule-set order that matches from the first character names the line; other matches are not hits', () => {
    const hits = resolveSectionHits({
      candidates,
      ruleSet: ruleSet(),
      verdict: {
        kind: 'ok',
        skipped: [],
        hits: [
          { inputIndex: 0, patternId: 'h:0', start: 0, end: 6 },
          { inputIndex: 1, patternId: 'h:3', start: 0, end: 2 },
          { inputIndex: 1, patternId: 'h:1', start: 0, end: 8 },
          { inputIndex: 1, patternId: '55555555-5555-4555-8555-555555555555', start: 0, end: 3 },
          { inputIndex: 2, patternId: 'h:1', start: 5, end: 13 },
        ],
      },
    });
    expect(hits).toEqual({ '## Part 1': PART, 'Part 1': PART, '1. Alpha': ALPHA });
    expect(Object.getPrototypeOf(hits)).toBe(Object.prototype);
  });

  test('a timeout or an error gives no hit', () => {
    expect(resolveSectionHits({ candidates, ruleSet: ruleSet(), verdict: { kind: 'timeout' } })).toEqual({});
    expect(resolveSectionHits({ candidates, ruleSet: ruleSet(), verdict: { kind: 'error', error: 'worker_failed' } })).toEqual({});
  });

  test('the hit map caps follow the contract', () => {
    const many: Record<string, typeof ALPHA> = {};
    for (let i = 0; i <= SECTION_HITS_CAP.maxEntries; i += 1) many[`${i}. Alpha`] = ALPHA;
    expect(hitsOverCap(many)).toBe(true);
    expect(hitsOverCap({ '1. Alpha': ALPHA })).toBe(false);
    expect(hitsOverCap({ ['x'.repeat(SECTION_HITS_CAP.maxKeyLength + 1)]: ALPHA })).toBe(true);
  });
});

describe('checkSectionRules', () => {
  test('a conforming document is satisfied with integer counts', () => {
    const markdown = part(1, ['1. Alpha', '2. Bravo']).join('\n');
    const result = checkSectionRules(markdown, rulesFor(markdown), ruleSet());
    expect(result).toEqual({ satisfied: true, reasons: [], counts: { headings: 3, variants: 0, skipped: 0 } });
  });

  test('a missing required heading', () => {
    const markdown = part(1, ['2. Bravo']).join('\n');
    expect(checkSectionRules(markdown, rulesFor(markdown), ruleSet())).toMatchObject({ satisfied: false, reasons: ['required_heading_missing'] });
  });

  test('numbers that go down within one parent, only when the rule set asks for increasing numbers', () => {
    const markdown = part(1, ['2. Alpha', '1. Bravo']).join('\n');
    expect(checkSectionRules(markdown, rulesFor(markdown), ruleSet()).reasons).toEqual(['numbers_not_increasing']);
    expect(checkSectionRules(markdown, rulesFor(markdown), ruleSet({ requireIncreasingNumbers: false })).satisfied).toBe(true);
    const nested = ['## Part 1', '1. Alpha', 'a', '1.2 Alpha', 'b', '1.10 Alpha', 'c'].join('\n');
    const rules = resolvedSectionRules(ruleSet(), { '## Part 1': PART, '1. Alpha': ALPHA, '1.2 Alpha': { ...ALPHA, level: 3 }, '1.10 Alpha': { ...ALPHA, level: 3 } });
    expect(checkSectionRules(nested, rules, ruleSet()).satisfied).toBe(true);
  });

  test('two variants: each must hold every required heading; numbering restarts per variant', () => {
    const both = [...part(1, ['1. Alpha', '2. Bravo']), ...part(2, ['1. Alpha', '2. Bravo'])].join('\n');
    expect(checkSectionRules(both, rulesFor(both), ruleSet())).toEqual({ satisfied: true, reasons: [], counts: { headings: 6, variants: 2, skipped: 0 } });
    const gap = [...part(1, ['1. Alpha', '2. Bravo']), ...part(2, ['2. Bravo'])].join('\n');
    expect(checkSectionRules(gap, rulesFor(gap), ruleSet()).reasons).toEqual(['required_heading_missing']);
  });

  test('a table-of-contents run is judged as the chunker cuts it: its skipped lines count as skipped, not as headings', () => {
    const toc = ['Part 1 ..... 1', '', '1. Alpha ..... 2', '', '2. Bravo ..... 3', '', 'This collection holds one part of sample text.', ''];
    const markdown = [...toc, ...part(1, ['1. Alpha', '2. Bravo'])].join('\n');
    const result = checkSectionRules(markdown, rulesFor(markdown), ruleSet());
    expect(result.satisfied).toBe(true);
    expect(result.counts).toEqual({ headings: 4, variants: 0, skipped: 2 });
  });

  test('no hit opens a section', () => {
    const markdown = 'Plain text only.\n\nMore plain text.';
    const result = checkSectionRules(markdown, resolvedSectionRules(ruleSet(), {}), ruleSet());
    expect(result.satisfied).toBe(false);
    expect(result.reasons).toContain('no_heading_found');
  });

  test('the module builds no expression from data', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/rag/ingest/prepare/section-hits.ts'), 'utf8');
    expect(source).not.toContain('RegExp(');
    expect(source).not.toMatch(/console\./);
  });
});
