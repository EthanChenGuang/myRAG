import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractIdentifiers, splitAtIdentifiers } from '@/lib/rag/ids/shapes';
import { chunkLexicalText } from '@/lib/rag/lexical/chunk-text';
import type { LexicalOptions } from '@/lib/rag/lexical/options';
import {
  MAX_ADDITIVE_QUERY_TOKENS,
  identifierLexicalLookupForms,
  lexicalText,
  lexicalTokens,
  queryLexicalTokens,
} from '@/lib/rag/lexical/tokenize';

// Synthetic shapes only: letters and digits with separators, one with no digit, one written with a space.
const NO_DIGIT = /\bkelvoran-[a-z]+\b/giu;
const WITH_SPACE = /\bmv \d{4} [a-z]\b/giu;
const PATTERNS = [NO_DIGIT, WITH_SPACE];

function rejoin(pieces: Array<{ text: string }>): string {
  return pieces.map((piece) => piece.text).join('');
}

describe('splitAtIdentifiers with extra patterns (D-28, D-30)', () => {
  const samples = ['发票FP-2025-0042 对应订单 PO_778/9, 税号 IT99999999990.', 'See FT-1. Then v2.3.1, ok', 'no identifier here', ''];

  it('returns exactly today\'s pieces without extra patterns or with an empty list', () => {
    expect(splitAtIdentifiers('See FT-1. Then v2.3.1, ok')).toStrictEqual([
      { text: 'See ', identifier: false },
      { text: 'FT-1', identifier: true },
      { text: '. Then ', identifier: false },
      { text: 'v2.3.1', identifier: true },
      { text: ', ok', identifier: false },
    ]);
    for (const sample of samples) {
      expect(splitAtIdentifiers(sample, undefined)).toStrictEqual(splitAtIdentifiers(sample));
      expect(splitAtIdentifiers(sample, [])).toStrictEqual(splitAtIdentifiers(sample));
      expect(extractIdentifiers(sample, [])).toStrictEqual(extractIdentifiers(sample));
    }
  });

  it('keeps built-in pieces unchanged when an extra pattern matches nothing', () => {
    for (const sample of samples) expect(splitAtIdentifiers(sample, [/zzzq\d/giu])).toStrictEqual(splitAtIdentifiers(sample));
  });

  it('adds a tenant match with no digit and one written with a space, in order', () => {
    const text = 'Kelvoran-Tusk sits next to MV 3302 K and QX-4471.';
    const pieces = splitAtIdentifiers(text, PATTERNS);
    expect(rejoin(pieces)).toBe(text);
    expect(pieces.filter((piece) => piece.identifier).map((piece) => piece.text)).toEqual(['Kelvoran-Tusk', 'MV 3302 K', 'QX-4471']);
    expect(extractIdentifiers(text)).toEqual(['3302', 'QX-4471']);
    expect(extractIdentifiers(text, PATTERNS)).toEqual(['Kelvoran-Tusk', 'MV 3302 K', 'QX-4471']);
  });

  it('merges leftmost-longest: the earlier start wins, then the longer match at the same start', () => {
    expect(extractIdentifiers('ref 4471 ab end', [/\d{4} [a-z]{2}/giu])).toEqual(['4471 ab']);
    expect(extractIdentifiers('ref qx-4471.v2 end', [/qx-\d+/giu])).toEqual(['qx-4471.v2']);
    expect(extractIdentifiers('ref qx-4471 ab end', [/4471 ab/giu])).toEqual(['qx-4471']);
    expect(extractIdentifiers('ab cd-12 ef', [/ab cd/giu])).toEqual(['ab cd', '12']);
  });

  it('never returns overlapping pieces across several patterns', () => {
    const text = 'kelvoran-tusk-90 mv 3302 k mv 3302 k';
    const pieces = splitAtIdentifiers(text, [...PATTERNS, /tusk-\d+/giu, /\d+ k/giu]);
    expect(rejoin(pieces)).toBe(text);
    expect(pieces.filter((piece) => piece.identifier).map((piece) => piece.text)).toEqual([
      'kelvoran-tusk-90',
      'mv 3302 k',
      'mv 3302 k',
    ]);
  });

  it('ignores empty matches and accepts a pattern compiled without the g flag', () => {
    expect(extractIdentifiers('ab QX-4471', [/z*/giu])).toEqual(['QX-4471']);
    expect(extractIdentifiers('Kelvoran-Tusk twice: kelvoran-tusk', [/\bkelvoran-[a-z]+\b/iu])).toEqual(['Kelvoran-Tusk', 'kelvoran-tusk']);
  });
});

describe('identifier tokens through options.identifierPatterns (D-30, D-55, pitfall 12)', () => {
  const opts: LexicalOptions = { identifierPatterns: PATTERNS };

  it('keeps a tenant identifier whole and adds its normalized form on the chunk side', () => {
    expect(lexicalTokens('Kelvoran-Tusk listed')).not.toContain('kelvoran-tusk');
    const tokens = lexicalTokens('Kelvoran-Tusk listed', opts);
    expect(tokens).toContain('kelvoran-tusk');
    expect(tokens).toContain('kelvorantusk');
    expect(tokens.filter((t) => t === 'kelvorantusk')).toHaveLength(1);
  });

  it('emits only the normalized form for a match that contains whitespace', () => {
    const base = lexicalTokens('listed under MV 3302 K today');
    const tokens = lexicalTokens('listed under MV 3302 K today', opts);
    expect(base).toContain('3302');
    expect(tokens).toContain('mv3302k');
    expect(tokens).not.toContain('3302');
    expect(tokens).not.toContain('mv');
    expect(tokens.every((t) => !/\s/u.test(t))).toBe(true);
    expect(lexicalText([], 'listed under MV 3302 K today', opts).split(' ')).toEqual(tokens);
  });

  it('matches the same normalized form for two spellings', () => {
    const a = lexicalTokens('see mv 3302 k', opts);
    const b = queryLexicalTokens('MV  3302　K?', opts);
    expect(a).toContain('mv3302k');
    expect(b).toContain('mv3302k');
  });

  it('puts normalized identifier tokens in the leading additive group of the query', () => {
    const query = queryLexicalTokens('where is MV 3302 K and Kelvoran-Tusk', opts);
    expect(query.slice(0, 2)).toEqual(['mv3302k', 'kelvorantusk']);
    expect(query).toContain('kelvoran-tusk');
    expect(new Set(query).size).toBe(query.length);
  });

  it('caps the additive group and keeps natural tokens after it', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `MV ${String(1000 + i)} K`);
    const query = queryLexicalTokens(`${ids.join(' then ')} trailing`, opts);
    const additive = query.filter((t) => /^mv\d{4}k$/u.test(t));
    expect(additive).toHaveLength(MAX_ADDITIVE_QUERY_TOKENS);
    expect(query.slice(0, MAX_ADDITIVE_QUERY_TOKENS)).toEqual(additive);
    expect(query).toContain('trailing');
  });

  it('leaves built-in identifier tokens as they are when the normalized form equals the joined one', () => {
    const text = '发票FP-2025-0042 对应订单 PO_778/9, 税号 IT99999999990.';
    expect(lexicalTokens(text, opts)).toEqual(lexicalTokens(text));
    expect(queryLexicalTokens(text, opts)).toEqual(queryLexicalTokens(text));
  });

  it('does not change the exact-id lookup forms of a built-in identifier', () => {
    expect(identifierLexicalLookupForms('QX-4471', opts)).toEqual(identifierLexicalLookupForms('QX-4471'));
  });
});

describe('identity with inert identifier options (D-08, D-42)', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  const CORPUS = path.join(ROOT, 'eval', 'fixtures', 'corpus');
  const files = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
      .sort();
  const corpus = files(CORPUS).map((file) => fs.readFileSync(file, 'utf8'));
  const INERT: Array<[string, LexicalOptions]> = [
    ['an empty pattern list', { identifierPatterns: [] }],
    ['a pattern that matches nothing', { identifierPatterns: [/zzzq\d{9}/giu] }],
  ];

  for (const [name, options] of INERT) {
    it(`gives the default output over the fixture corpus with ${name}`, () => {
      expect(corpus.length).toBeGreaterThanOrEqual(19);
      for (const text of corpus) {
        expect(lexicalTokens(text, options)).toEqual(lexicalTokens(text));
        expect(queryLexicalTokens(text, options)).toEqual(queryLexicalTokens(text));
        const input = { sectionPath: ['Part'], content: text, chunkKind: 'text', metadata: {}, documentFilename: 'file.md', tableRowSeparator: ',' } as const;
        expect(chunkLexicalText(input, options)).toEqual(chunkLexicalText(input));
      }
    });
  }
});

describe('hostile input with an extra pattern (T-04.2-14)', () => {
  it('finishes under one second on 200 KB', () => {
    const input = 'kelvoran-'.repeat(200 * 1024 / 9);
    const started = performance.now();
    extractIdentifiers(input, PATTERNS);
    lexicalTokens(input, { identifierPatterns: PATTERNS });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
