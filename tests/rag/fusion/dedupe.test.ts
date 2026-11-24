import { describe, expect, it } from 'vitest';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { dedupeAndCap } from '@/lib/rag/fusion/dedupe';
import { hit } from './helpers';

function fusedRows(rows: Array<{ chunkId: string; parentId?: string | null; score?: number }>): FusedHit[] {
  return rows.map((row, index) => ({
    hit: hit(row.chunkId, { parentId: row.parentId ?? null }),
    score: row.score ?? 1 / (index + 1),
    ranks: { 'dense:0': index + 1 },
  }));
}

describe('dedupeAndCap', () => {
  it('keeps the first fused entry per chunk id', () => {
    const input = fusedRows([
      { chunkId: 'c1', score: 0.9 },
      { chunkId: 'c1', score: 0.5 },
      { chunkId: 'c2', score: 0.4 },
    ]);
    const { hits, counts } = dedupeAndCap(input, { byParent: false, cap: 75 });
    expect(hits.map((h) => h.hit.chunkId)).toEqual(['c1', 'c2']);
    expect(counts).toMatchObject({ candidates_in: 3, deduped: 1, rerank_input: 2, capped_from: 2 });
  });

  it('dedupes by parent when enabled and never merges null parents', () => {
    const input = fusedRows([
      { chunkId: 'child-a', parentId: 'parent-1', score: 0.9 },
      { chunkId: 'child-b', parentId: 'parent-1', score: 0.8 },
      { chunkId: 'solo', parentId: null, score: 0.7 },
      { chunkId: 'solo-dup', parentId: null, score: 0.6 },
    ]);
    const { hits, counts } = dedupeAndCap(input, { byParent: true, cap: 75 });
    expect(hits.map((h) => h.hit.chunkId)).toEqual(['child-a', 'solo', 'solo-dup']);
    expect(counts.deduped).toBe(1);

    const bothChildren = dedupeAndCap(
      fusedRows([
        { chunkId: 'child-a', parentId: 'parent-1' },
        { chunkId: 'child-b', parentId: 'parent-1' },
      ]),
      { byParent: false, cap: 75 },
    );
    expect(bothChildren.hits.map((h) => h.hit.chunkId)).toEqual(['child-a', 'child-b']);
  });

  it('caps to rerank input and reports counts', () => {
    const many = fusedRows(
      Array.from({ length: 120 }, (_, i) => ({ chunkId: `chunk-${i}` })),
    );
    const capped = dedupeAndCap(many, { byParent: false, cap: 75 });
    expect(capped.hits).toHaveLength(75);
    expect(capped.counts).toEqual({
      candidates_in: 120,
      deduped: 0,
      rerank_input: 75,
      capped_from: 120,
    });

    const few = dedupeAndCap(
      fusedRows(Array.from({ length: 40 }, (_, i) => ({ chunkId: `few-${i}` }))),
      { byParent: false, cap: 75 },
    );
    expect(few.hits).toHaveLength(40);
    expect(few.counts).toEqual({
      candidates_in: 40,
      deduped: 0,
      rerank_input: 40,
      capped_from: 40,
    });
  });

  it('preserves fused order among survivors', () => {
    const input = fusedRows([
      { chunkId: 'first', score: 0.9 },
      { chunkId: 'second', score: 0.8 },
      { chunkId: 'third', score: 0.7 },
    ]);
    const { hits } = dedupeAndCap(input, { byParent: false, cap: 2 });
    expect(hits.map((h) => h.hit.chunkId)).toEqual(['first', 'second']);
  });
});