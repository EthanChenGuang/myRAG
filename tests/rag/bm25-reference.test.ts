import { describe, expect, it } from 'vitest';
import { bm25Reference } from '../helpers/bm25-reference';
import { neutralLexicalCorpus, zipfPicker } from '../helpers/neutral-lexical-corpus';

const EPS = 1e-9;

describe('bm25Reference', () => {
  // N = 3, avgdl = (3 + 2 + 4) / 3 = 3, df(a) = 1, df(c) = 2, k1 = 1.2, b = 0.75
  // idf(a) = ln(1 + (3 - 1 + 0.5) / (1 + 0.5)) = ln(8 / 3)  = 0.9808292530117264
  // idf(c) = ln(1 + (3 - 2 + 0.5) / (2 + 0.5)) = ln(1.6)    = 0.4700036292457356
  // d1 [a a b]:   a tf 2, dl 3: idf(a) * 2 * 2.2 / (2 + 1.2 * (0.25 + 0.75 * 3 / 3)) = idf(a) * 4.4 / 3.2 = 1.3486402228911238
  // d2 [b c]:     c tf 1, dl 2: idf(c) * 1 * 2.2 / (1 + 1.2 * (0.25 + 0.75 * 2 / 3)) = idf(c) * 2.2 / 1.9 = 0.5442147286003254
  // d3 [c c c c]: c tf 4, dl 4: idf(c) * 4 * 2.2 / (4 + 1.2 * (0.25 + 0.75 * 4 / 3)) = idf(c) * 8.8 / 5.5 = 0.7520058067931769
  const docs = [
    ['a', 'a', 'b'],
    ['b', 'c'],
    ['c', 'c', 'c', 'c'],
  ];

  it('matches the hand-computed scores', () => {
    const scores = bm25Reference({ docs, query: ['a', 'c'], k1: 1.2, b: 0.75 });
    expect(scores).toHaveLength(3);
    expect(Math.abs(scores[0] - 1.3486402228911238)).toBeLessThan(EPS);
    expect(Math.abs(scores[1] - 0.5442147286003254)).toBeLessThan(EPS);
    expect(Math.abs(scores[2] - 0.7520058067931769)).toBeLessThan(EPS);
  });

  it('ignores absent terms and counts a duplicate query term once', () => {
    const base = bm25Reference({ docs, query: ['a', 'c'], k1: 1.2, b: 0.75 });
    expect(bm25Reference({ docs, query: ['a', 'c', 'zz'], k1: 1.2, b: 0.75 })).toEqual(base);
    expect(bm25Reference({ docs, query: ['a', 'a', 'c', 'c', 'c'], k1: 1.2, b: 0.75 })).toEqual(base);
    expect(bm25Reference({ docs, query: ['zz'], k1: 1.2, b: 0.75 })).toEqual([0, 0, 0]);
  });

  it('gives all zeros for an empty query', () => {
    expect(bm25Reference({ docs, query: [], k1: 1.2, b: 0.75 })).toEqual([0, 0, 0]);
  });

  it('makes scores independent of length when b = 0', () => {
    const lengthDocs = [['x'], ['x', 'y', 'y', 'y', 'y', 'y', 'y', 'y'], ['z']];
    const scores = bm25Reference({ docs: lengthDocs, query: ['x'], k1: 1.2, b: 0 });
    expect(scores[0]).toBeGreaterThan(0);
    expect(Math.abs(scores[0] - scores[1])).toBeLessThan(EPS);
    const withB = bm25Reference({ docs: lengthDocs, query: ['x'], k1: 1.2, b: 0.75 });
    expect(withB[0]).toBeGreaterThan(withB[1]);
  });

  it('never lowers a higher-tf document relative to a tf-1 document as k1 grows', () => {
    const tfDocs = [['t', 'u', 'u'], ['t', 't', 't'], ['v', 'v', 'v']];
    let previousRatio = 0;
    for (const k1 of [0.1, 0.5, 1.2, 2, 5, 20]) {
      const [one, many] = bm25Reference({ docs: tfDocs, query: ['t'], k1, b: 0.75 });
      expect(many).toBeGreaterThanOrEqual(one);
      const ratio = many / one;
      expect(ratio).toBeGreaterThanOrEqual(previousRatio - EPS);
      previousRatio = ratio;
    }
  });

  it('uses explicit statistics and clamps df to [1, N]', () => {
    const k1 = 1.2;
    const b = 0.75;
    const stats = { N: 10, avgdl: 5, df: new Map([['a', 4], ['c', 0], ['b', 99]]) };
    const scores = bm25Reference({ docs, query: ['a', 'b', 'c'], k1, b, stats });
    const idf = (df: number) => Math.log(1 + (10 - df + 0.5) / (df + 0.5));
    const part = (tf: number, dl: number) => (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / 5));
    expect(Math.abs(scores[0] - (idf(4) * part(2, 3) + idf(10) * part(1, 3)))).toBeLessThan(EPS);
    expect(Math.abs(scores[1] - (idf(10) * part(1, 2) + idf(1) * part(1, 2)))).toBeLessThan(EPS);
    expect(Math.abs(scores[2] - idf(1) * part(4, 4))).toBeLessThan(EPS);

    const recordStats = { N: 10, avgdl: 5, df: { a: 4, c: 0, b: 99 } };
    expect(bm25Reference({ docs, query: ['a', 'b', 'c'], k1, b, stats: recordStats })).toEqual(scores);
  });

  it('treats a term missing from explicit df as df 1', () => {
    const stats = { N: 4, avgdl: 3, df: new Map<string, number>() };
    const [score] = bm25Reference({ docs: [['q']], query: ['q'], k1: 1.2, b: 0.75, stats });
    const expected = Math.log(1 + 3.5 / 1.5) * (2.2 / (1 + 1.2 * (0.25 + 0.75 / 3)));
    expect(Math.abs(score - expected)).toBeLessThan(EPS);
  });
});

describe('neutralLexicalCorpus', () => {
  const options = { seed: 7, chunks: 50, vocabulary: 200, minLength: 5, maxLength: 20 };

  it('is deterministic for a seed and matches the committed snapshot', () => {
    const first = neutralLexicalCorpus(options);
    const second = neutralLexicalCorpus(options);
    expect(first).toEqual(second);
    expect(first).toHaveLength(50);
    expect(first.slice(0, 3)).toEqual(SNAPSHOT_SEED_7);
  });

  it('draws only generated tokens within the vocabulary and length bounds', () => {
    const corpus = neutralLexicalCorpus(options);
    for (const doc of corpus) {
      expect(doc.length).toBeGreaterThanOrEqual(5);
      expect(doc.length).toBeLessThanOrEqual(20);
      for (const token of doc) {
        expect(token).toMatch(/^w[0-9]+$/);
        expect(Number(token.slice(1))).toBeLessThan(200);
      }
    }
  });

  it('gives a different corpus for a different seed', () => {
    expect(neutralLexicalCorpus({ ...options, seed: 8 })).not.toEqual(neutralLexicalCorpus(options));
  });

  it('skews token frequency towards low ranks', () => {
    const counts = new Map<string, number>();
    for (const doc of neutralLexicalCorpus({ ...options, chunks: 400 })) {
      for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    expect(counts.get('w0') ?? 0).toBeGreaterThan((counts.get('w100') ?? 0) * 5);
  });

  it('exposes a seeded Zipf picker over ranks', () => {
    const pickA = zipfPicker({ seed: 3, size: 10 });
    const pickB = zipfPicker({ seed: 3, size: 10 });
    const drawsA = Array.from({ length: 100 }, () => pickA());
    const drawsB = Array.from({ length: 100 }, () => pickB());
    expect(drawsA).toEqual(drawsB);
    for (const rank of drawsA) {
      expect(Number.isInteger(rank)).toBe(true);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(10);
    }
  });
});

const SNAPSHOT_SEED_7: string[][] = [
  ['w120', 'w20', 'w130', 'w0', 'w85', 'w4', 'w0', 'w0'],
  ['w170', 'w12', 'w7', 'w13', 'w19', 'w53', 'w54', 'w6', 'w8', 'w83', 'w4', 'w9', 'w0', 'w45', 'w75', 'w4', 'w1', 'w179', 'w0', 'w7'],
  ['w0', 'w0', 'w21', 'w52', 'w0', 'w19', 'w129', 'w2', 'w17', 'w3', 'w3', 'w10'],
];
