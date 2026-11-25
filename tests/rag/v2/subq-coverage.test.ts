import { describe, expect, it } from 'vitest';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import type { QueryVariant } from '@/lib/rag/types';
import { reserveSubQuestionCoverage } from '@/lib/rag/v2/subq-coverage';
import { hit } from '../fusion/helpers';

function variantsWithSubQuestions(count: number): QueryVariant[] {
  const variants: QueryVariant[] = [{ text: 'compound question', language: 'en', kind: 'original' }];
  for (let index = 0; index < count; index++) {
    variants.push({ text: `part ${index}`, language: 'en', kind: 'sub_question', subQuestionIndex: index });
  }
  return variants;
}

/** Sub-question s searches variant s + 1 (variant 0 is the original). */
function row(chunkId: string, ranks: Record<string, number>): FusedHit {
  return { hit: hit(chunkId), score: 0, ranks };
}

function ids(rows: FusedHit[]): string[] {
  return rows.map((entry) => entry.hit.chunkId);
}

describe('reserveSubQuestionCoverage (D-07)', () => {
  it('replaces the lowest-ranked top-k entry with the best pool candidate of an uncovered sub-question', () => {
    const variants = variantsWithSubQuestions(3);
    const topK = [
      row('a', { 'dense:0': 1, 'dense:1': 1 }),
      row('b', { 'dense:2': 1 }),
      row('c', { 'lexical:1': 2 }),
      row('d', { 'dense:0': 2 }),
      row('e', { 'dense:2': 3 }),
    ];
    const pool = [row('f', { 'dense:0': 3 }), row('g', { 'lexical:3': 4 }), row('h', { 'dense:3': 1 })];

    const out = reserveSubQuestionCoverage(topK, pool, variants, { enabled: true, max: 4 });

    expect(ids(out.topK)).toEqual(['a', 'b', 'c', 'd', 'g']);
    expect(ids(out.pool)).toEqual(['e', 'f', 'h']);
    expect(out.reserved).toBe(1);
  });

  it('makes at most four reservations when six sub-questions are uncovered', () => {
    const variants = variantsWithSubQuestions(6);
    const topK = Array.from({ length: 8 }, (_, index) => row(`t${index}`, { 'dense:0': index + 1 }));
    const pool = Array.from({ length: 6 }, (_, index) => row(`s${index}`, { [`dense:${index + 1}`]: 1 }));

    const out = reserveSubQuestionCoverage(topK, pool, variants, { enabled: true, max: 4 });

    expect(out.reserved).toBe(4);
    expect(out.topK).toHaveLength(8);
    expect(ids(out.topK)).toEqual(['t0', 't1', 't2', 't3', 's0', 's1', 's2', 's3']);
    expect(ids(out.pool)).toEqual(['t4', 't5', 't6', 't7', 's4', 's5']);
  });

  it('caps reservations at four even when a larger max is passed', () => {
    const variants = variantsWithSubQuestions(6);
    const topK = Array.from({ length: 8 }, (_, index) => row(`t${index}`, { 'dense:0': index + 1 }));
    const pool = Array.from({ length: 6 }, (_, index) => row(`s${index}`, { [`dense:${index + 1}`]: 1 }));

    const out = reserveSubQuestionCoverage(topK, pool, variants, { enabled: true, max: 10 });

    expect(out.reserved).toBe(4);
  });

  it('never duplicates a candidate already in the top-k', () => {
    const variants = variantsWithSubQuestions(2);
    const shared = row('x', { 'dense:1': 1 });
    const topK = [shared, row('y', { 'dense:0': 1 }), row('z', { 'dense:0': 2 })];
    const pool = [row('x', { 'dense:1': 1, 'dense:2': 1 }), row('w', { 'dense:2': 2 })];

    const out = reserveSubQuestionCoverage(topK, pool, variants, { enabled: true, max: 4 });

    expect(ids(out.topK)).toEqual(['x', 'y', 'w']);
    expect(new Set(ids(out.topK)).size).toBe(out.topK.length);
    expect(ids([...out.topK, ...out.pool]).filter((id) => id === 'x')).toHaveLength(1);
    expect(out.reserved).toBe(1);
  });

  it('does not displace the only entry that covers another sub-question', () => {
    const variants = variantsWithSubQuestions(3);
    const topK = [row('a', { 'dense:0': 1 }), row('b', { 'dense:1': 1 }), row('c', { 'dense:2': 1 })];
    const pool = [row('d', { 'dense:3': 1 })];

    const out = reserveSubQuestionCoverage(topK, pool, variants, { enabled: true, max: 4 });

    expect(ids(out.topK)).toEqual(['d', 'b', 'c']);
    expect(ids(out.pool)).toEqual(['a']);
    expect(out.reserved).toBe(1);
  });

  it('returns the input unchanged when coverage is off or there are no sub-questions', () => {
    const topK = [row('a', { 'dense:0': 1 }), row('b', { 'dense:0': 2 })];
    const pool = [row('c', { 'dense:1': 1 })];

    const off = reserveSubQuestionCoverage(topK, pool, variantsWithSubQuestions(1), { enabled: false, max: 4 });
    expect(off.topK).toBe(topK);
    expect(off.pool).toBe(pool);
    expect(off.reserved).toBe(0);

    const none = reserveSubQuestionCoverage(topK, pool, variantsWithSubQuestions(0), { enabled: true, max: 4 });
    expect(none.topK).toBe(topK);
    expect(none.pool).toBe(pool);
    expect(none.reserved).toBe(0);
  });

  it('reserves nothing for a sub-question with no candidate at all', () => {
    const variants = variantsWithSubQuestions(2);
    const topK = [row('a', { 'dense:0': 1, 'dense:1': 1 }), row('b', { 'dense:0': 2 })];
    const pool = [row('c', { 'dense:0': 3 })];

    const out = reserveSubQuestionCoverage(topK, pool, variants, { enabled: true, max: 4 });

    expect(ids(out.topK)).toEqual(['a', 'b']);
    expect(ids(out.pool)).toEqual(['c']);
    expect(out.reserved).toBe(0);
  });
});
