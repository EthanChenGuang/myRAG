import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_INPUT_CHARS,
  damerauLevenshtein,
  extractIdentifierEntries,
  isNearMissIdentifier,
  normalizeIdentifier,
} from '@/lib/rag/ids/normalize';

interface VectorCase {
  id: string;
  asked: string;
  other: string;
  asked_norm: string;
  other_norm: string;
  distance: number;
  near_miss: boolean;
}

const VECTOR_FILE = path.resolve(__dirname, '..', '..', 'fixtures', 'identifiers', 'near-miss-vectors.json');
const vectors = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8')) as { version: number; cases: VectorCase[] };

describe('shared near-miss vectors (D-28, D-31)', () => {
  it('holds at least 20 cases with unique ids, covering both length classes', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(vectors.cases.map((c) => c.id)).size).toBe(vectors.cases.length);
    const lengths = vectors.cases.filter((c) => c.near_miss).map((c) => [...c.asked_norm].length);
    expect(lengths.some((n) => n <= 6)).toBe(true);
    expect(lengths.some((n) => n > 6)).toBe(true);
  });

  for (const c of vectors.cases) {
    it(`${c.id}: normalizes, measures and judges both spellings`, () => {
      expect(normalizeIdentifier(c.asked)).toBe(c.asked_norm);
      expect(normalizeIdentifier(c.other)).toBe(c.other_norm);
      expect(damerauLevenshtein(c.asked_norm, c.other_norm)).toBe(c.distance);
      expect(damerauLevenshtein(c.other_norm, c.asked_norm)).toBe(c.distance);
      expect(isNearMissIdentifier(c.asked_norm, c.other_norm)).toBe(c.near_miss);
    });
  }
});

describe('normalizeIdentifier', () => {
  it('folds width and case and removes whitespace and each separator', () => {
    expect(normalizeIdentifier('ＫＴ－９０')).toBe('kt90');
    expect(normalizeIdentifier(' Kt 9\t0 ')).toBe('kt90');
    for (const sep of ['-', '_', '.', '/', ' ', '　', ' ']) expect(normalizeIdentifier(`KT${sep}90`)).toBe('kt90');
  });

  it('keeps other punctuation and returns the empty string when nothing is left', () => {
    expect(normalizeIdentifier('KT:90')).toBe('kt:90');
    expect(normalizeIdentifier(' -_./ ')).toBe('');
    expect(normalizeIdentifier('')).toBe('');
  });
});

describe('damerauLevenshtein', () => {
  it('counts each edit kind as one', () => {
    expect(damerauLevenshtein('abc9', 'abc9')).toBe(0);
    expect(damerauLevenshtein('abc9', 'abd9')).toBe(1);
    expect(damerauLevenshtein('abc9', 'abcx9')).toBe(1);
    expect(damerauLevenshtein('abc9', 'ab9')).toBe(1);
    expect(damerauLevenshtein('abc9', 'acb9')).toBe(1);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
  });

  it('counts code points, not UTF-16 units', () => {
    expect(damerauLevenshtein('a\u{20000}1', 'a\u{20001}1')).toBe(1);
  });

  it('stops early above the maximum and returns a value above it', () => {
    expect(damerauLevenshtein('qx4471', 'lm9902', 1)).toBeGreaterThan(1);
    expect(damerauLevenshtein('qx', 'qx4471', 2)).toBeGreaterThan(2);
    expect(damerauLevenshtein('qx4471', 'qx4472', 1)).toBe(1);
    expect(damerauLevenshtein('qx4471', 'qx4471', 0)).toBe(0);
  });
});

describe('isNearMissIdentifier (D-31 rule)', () => {
  it('is false for equal forms and for an empty asked form', () => {
    expect(isNearMissIdentifier('qx4471', 'qx4471')).toBe(false);
    expect(isNearMissIdentifier('', 'q')).toBe(false);
  });

  it('allows one edit up to six code points and two above', () => {
    expect(isNearMissIdentifier('ab1234', 'ab1235')).toBe(true);
    expect(isNearMissIdentifier('ab1234', 'ab1255')).toBe(false);
    expect(isNearMissIdentifier('ab12345', 'ab12355')).toBe(true);
    expect(isNearMissIdentifier('ab12345', 'ab12555')).toBe(false);
  });
});

describe('extractIdentifierEntries', () => {
  it('returns raw and normalized forms de-duplicated by the normalized form', () => {
    expect(extractIdentifierEntries('Ref QX-4471, then qx4471 and ZR7B-30915.')).toEqual([
      { raw: 'QX-4471', norm: 'qx4471' },
      { raw: 'ZR7B-30915', norm: 'zr7b30915' },
    ]);
  });

  it('folds width before matching so full-width spellings are found', () => {
    expect(extractIdentifierEntries('Ref ＱＸ－４４７１ here')).toEqual([{ raw: 'QX-4471', norm: 'qx4471' }]);
  });

  it('adds tenant-pattern matches, including one with no digit and one written with a space', () => {
    const patterns = [/\bkelvoran-[a-z]+\b/giu, /\bmv \d{4} [a-z]\b/giu];
    expect(extractIdentifierEntries('Kelvoran-Tusk is listed under MV 3302 K and mv-3302-k.', patterns)).toEqual([
      { raw: 'Kelvoran-Tusk', norm: 'kelvorantusk' },
      { raw: 'MV 3302 K', norm: 'mv3302k' },
    ]);
  });

  it('reads at most MAX_IDENTIFIER_INPUT_CHARS characters per call', () => {
    const filler = 'x '.repeat(MAX_IDENTIFIER_INPUT_CHARS / 2);
    expect(extractIdentifierEntries(`QX-4471 ${filler}ZR7B-30915`)).toEqual([{ raw: 'QX-4471', norm: 'qx4471' }]);
  });
});
