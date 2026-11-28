import { describe, expect, it } from 'vitest';
import { dedupeAndCap } from '@/lib/rag/fusion/dedupe';
import { rrf, type RankedList } from '@/lib/rag/fusion/rrf';
import { reserveTerminologyHits } from '@/lib/rag/terminology/reserve';
import { RetrievalParamsSchema, TerminologyParamsSchema } from '@/lib/rag-eval/contracts.generated';
import { hit, rankedList } from '../fusion/helpers';

const TERM = 'term:0';

/** D-34: every pool, cap, weight and rrf_k is passed by the test and asserted against what was passed. */
const K = 60;
const EXPANSION_WEIGHT = TerminologyParamsSchema.parse({}).expansion_weight;

function capRange(): number[] {
  const cap = RetrievalParamsSchema.shape.rerank_input_cap.removeDefault();
  const min = cap.minValue!;
  const max = cap.maxValue!;
  return [min, Math.round((min + max) / 2), max];
}

function poolMax(): number {
  return RetrievalParamsSchema.shape.candidate_pool_size.removeDefault().maxValue!;
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

function fuseWithTerm(original: string[], termIds: string[], k = K) {
  const lists: RankedList[] = [rankedList('dense:0', original), rankedList(TERM, termIds, EXPANSION_WEIGHT)];
  const fused = rrf(lists, k);
  return { fused, termHits: lists[1]!.hits };
}

describe('reserveTerminologyHits (D-34, PO-9)', () => {
  it('returns the input unchanged with no term:0 list or with reserve_slots 0', () => {
    const { fused, termHits } = fuseWithTerm(ids('orig', 6), ['gold']);
    const base = dedupeAndCap(fused, { byParent: false, cap: 4 });
    const snapshot = JSON.stringify(base);
    expect(reserveTerminologyHits(base, fused, null, { reserveSlots: 2, byParent: false })).toBe(base);
    expect(reserveTerminologyHits(base, fused, [], { reserveSlots: 2, byParent: false })).toBe(base);
    expect(reserveTerminologyHits(base, fused, termHits, { reserveSlots: 0, byParent: false })).toBe(base);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base.counts).not.toHaveProperty('term_reserved');
  });

  it('does not reserve a term:0 hit already in the rerank input, nor one whose parent is represented with byParent', () => {
    const lists: RankedList[] = [
      {
        id: 'dense:0',
        weight: 1,
        hits: ids('orig', 6).map((chunkId, index) => hit(chunkId, { rank: index + 1, parentId: `parent-${chunkId}` })),
      },
      {
        id: TERM,
        weight: EXPANSION_WEIGHT,
        hits: [hit('orig-2', { rank: 1, parentId: 'parent-orig-2' }), hit('sibling', { rank: 2, parentId: 'parent-orig-1' })],
      },
    ];
    const fused = rrf(lists, K);
    const byParent = dedupeAndCap(fused, { byParent: true, cap: 4 });
    const out = reserveTerminologyHits(byParent, fused, lists[1]!.hits, { reserveSlots: 2, byParent: true });
    expect(out.hits.map((row) => row.hit.chunkId)).toEqual(byParent.hits.map((row) => row.hit.chunkId));
    expect(out.counts.term_reserved).toBe(0);

    const flat = dedupeAndCap(fused, { byParent: false, cap: 4 });
    const flatOut = reserveTerminologyHits(flat, fused, lists[1]!.hits, { reserveSlots: 2, byParent: false });
    expect(flatOut.hits.at(-1)?.hit.chunkId).toBe('sibling');
    expect(flatOut.counts.term_reserved).toBe(1);
  });

  it('replaces the lowest-ranked entries with the reserved hits in term:0 rank order, keeping scores, order and length', () => {
    const original = ids('orig', 8);
    const { fused, termHits } = fuseWithTerm(original, ['gold-a', 'orig-1', 'gold-b']);
    const cap = 6;
    const base = dedupeAndCap(fused, { byParent: false, cap });
    expect(base.hits.map((row) => row.hit.chunkId)).not.toContain('gold-a');
    const out = reserveTerminologyHits(base, fused, termHits, { reserveSlots: 2, byParent: false });
    expect(out.hits).toHaveLength(cap);
    expect(out.hits.slice(0, cap - 2)).toEqual(base.hits.slice(0, cap - 2));
    expect(out.hits.slice(cap - 2).map((row) => row.hit.chunkId)).toEqual(['gold-a', 'gold-b']);
    for (const row of out.hits.slice(cap - 2)) {
      expect(row).toEqual(fused.find((entry) => entry.hit.chunkId === row.hit.chunkId));
    }
    expect(out.counts).toEqual({ ...base.counts, term_reserved: 2 });
    expect(out.counts.rerank_input).toBe(cap);
  });

  it('never replaces more than half of the rerank input', () => {
    const { fused, termHits } = fuseWithTerm(ids('orig', 10), ids('gold', 4));
    const cap = 5;
    const base = dedupeAndCap(fused, { byParent: false, cap });
    const out = reserveTerminologyHits(base, fused, termHits, { reserveSlots: 4, byParent: false });
    const half = Math.floor(cap / 2);
    expect(out.counts.term_reserved).toBe(half);
    expect(out.hits).toHaveLength(cap);
    expect(out.hits.slice(cap - half).map((row) => row.hit.chunkId)).toEqual(ids('gold', half));
  });

  it('with full original lists the gold term:0 hit is outside plain dedupe-and-cap and inside after the reservation, at every tested cap', () => {
    const pool = poolMax();
    const reserveSlots = TerminologyParamsSchema.parse({}).reserve_slots;
    const lists: RankedList[] = [
      rankedList('dense:0', ids('dense', pool)),
      rankedList('lexical:0', ids('lexical', pool)),
      rankedList(TERM, ['gold', ...ids('term', pool - 1)], EXPANSION_WEIGHT),
    ];
    const fused = rrf(lists, K);
    for (const cap of capRange()) {
      expect(cap).toBeLessThanOrEqual(pool);
      const base = dedupeAndCap(fused, { byParent: false, cap });
      expect(base.hits.map((row) => row.hit.chunkId)).not.toContain('gold');
      const out = reserveTerminologyHits(base, fused, lists[2]!.hits, { reserveSlots, byParent: false });
      expect(out.hits).toHaveLength(cap);
      expect(out.hits[cap - reserveSlots]?.hit.chunkId).toBe('gold');
      expect(out.counts.term_reserved).toBe(reserveSlots);
    }
  });
});
