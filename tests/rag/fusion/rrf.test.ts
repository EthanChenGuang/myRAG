import { describe, expect, it } from 'vitest';
import { rrf, type FusedHit } from '@/lib/rag/fusion/rrf';
import { hit, rankedList } from './helpers';

function chunkIds(fused: FusedHit[]): string[] {
  return fused.map((f) => f.hit.chunkId);
}

describe('rrf', () => {
  it('fuses two weighted lists with k=60', () => {
    const fused = rrf(
      [
        rankedList('dense:0', ['a', 'b', 'c']),
        rankedList('lexical:0', ['c', 'a']),
      ],
      60,
    );
    expect(chunkIds(fused)).toEqual(['a', 'c', 'b']);
    const byId = Object.fromEntries(fused.map((f) => [f.hit.chunkId, f.score]));
    const scoreA = 1 / 61 + 1 / 62;
    const scoreC = 1 / 63 + 1 / 61;
    const scoreB = 1 / 62;
    expect(byId.a).toBeCloseTo(scoreA, 12);
    expect(byId.c).toBeCloseTo(scoreC, 12);
    expect(byId.b).toBeCloseTo(scoreB, 12);
  });

  it('breaks score ties by chunk id ascending', () => {
    const fused = rrf([rankedList('dense:0', ['chunk-b']), rankedList('lexical:0', ['chunk-a'])], 60);
    expect(chunkIds(fused)).toEqual(['chunk-a', 'chunk-b']);
    expect(fused[0].score).toBeCloseTo(fused[1].score, 12);
  });

  it('returns single-list order unchanged', () => {
    const fused = rrf([rankedList('dense:0', ['x', 'y', 'z'])], 60);
    expect(chunkIds(fused)).toEqual(['x', 'y', 'z']);
  });

  it('ignores weight-0 lists and empty lists', () => {
    const withZero = rrf(
      [
        rankedList('dense:0', ['a', 'b']),
        rankedList('lexical:0', ['b', 'a'], 0),
      ],
      60,
    );
    expect(chunkIds(withZero)).toEqual(['a', 'b']);

    const withEmpty = rrf([rankedList('dense:0', ['a']), rankedList('lexical:0', [], 1)], 60);
    expect(chunkIds(withEmpty)).toEqual(['a']);
  });

  it('records per-list ranks and keeps the first hit payload in list-id order', () => {
    const denseHit = hit('c1', { content: 'from-dense', rank: 1 });
    const lexicalHit = hit('c1', { content: 'from-lexical', rank: 2 });
    const fused = rrf(
      [
        { id: 'dense:0', weight: 1, hits: [denseHit] },
        { id: 'lexical:0', weight: 1, hits: [lexicalHit] },
      ],
      60,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].ranks).toEqual({ 'dense:0': 1, 'lexical:0': 2 });
    expect(fused[0].hit.content).toBe('from-dense');
  });

  it('sums lists in sorted list-id order regardless of input array order', () => {
    const lists = [
      rankedList('lexical:0', ['c', 'a']),
      rankedList('dense:0', ['a', 'b', 'c']),
    ];
    const forward = rrf(lists, 60);
    const shuffled = rrf([lists[1], lists[0]], 60);
    expect(forward.map((f) => [f.hit.chunkId, f.score])).toEqual(
      shuffled.map((f) => [f.hit.chunkId, f.score]),
    );
  });
});