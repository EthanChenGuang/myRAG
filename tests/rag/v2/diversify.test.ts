import { describe, expect, it } from 'vitest';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { diversify, type DiversifyOptions } from '@/lib/rag/v2/diversify';
import { hit } from '../fusion/helpers';

interface RowSpec {
  doc?: string;
  cluster?: string;
  content?: string;
  score?: number;
}

function row(chunkId: string, spec: RowSpec = {}): FusedHit {
  const documentId = spec.doc ?? `doc-${chunkId}`;
  return {
    hit: hit(chunkId, {
      documentId,
      content: spec.content ?? `zorvik ${chunkId} plenth ${chunkId}x`,
      document: { filename: `${documentId}.txt`, createdAt: null, metadata: {}, contentPreview: '' },
      ...(spec.cluster ? { dupClusterId: spec.cluster } : {}),
    }),
    score: spec.score ?? 0,
    ranks: {},
  };
}

function ids(rows: FusedHit[]): string[] {
  return rows.map((entry) => entry.hit.chunkId);
}

function options(overrides: Partial<DiversifyOptions> = {}): DiversifyOptions {
  return { mode: 'collapse', lambda: 0.7, windowFactor: 3, finalTopK: 5, ...overrides };
}

function descending(rows: FusedHit[]): FusedHit[] {
  return rows.map((entry, index) => ({ ...entry, score: 1 - index * 0.1 }));
}

const flooded = (): FusedHit[] =>
  descending([
    row('a1', { cluster: 'X', doc: 'd-a1' }),
    row('b', { doc: 'd-b' }),
    row('a2', { cluster: 'X', doc: 'd-a2' }),
    row('a3', { cluster: 'X', doc: 'd-a3' }),
    row('c', { doc: 'd-c' }),
  ]);

describe('diversify (D-21, D-48)', () => {
  it('mode off returns the same array instance and no alsoIn', () => {
    const input = flooded();
    const out = diversify(input, options({ mode: 'off' }));
    expect(out.hits).toBe(input);
    expect(out.alsoIn.size).toBe(0);
    expect(out.counts).toEqual({ in: 5, kept: 5, collapsed: 0, mmr_moved: 0 });
  });

  it('collapse keeps the best-ranked chunk of a cluster and lists the dropped documents in rank order', () => {
    const out = diversify(flooded(), options());
    expect(ids(out.hits)).toEqual(['a1', 'b', 'c']);
    expect(out.alsoIn.get('a1')).toEqual([
      { documentId: 'd-a2', filename: 'd-a2.txt', chunkId: 'a2' },
      { documentId: 'd-a3', filename: 'd-a3.txt', chunkId: 'a3' },
    ]);
    expect(out.alsoIn.has('b')).toBe(false);
    expect(out.counts).toEqual({ in: 5, kept: 3, collapsed: 2, mmr_moved: 0 });
  });

  it('never drops a hit without a cluster id', () => {
    const input = descending([row('p'), row('q'), row('r', { content: 'zorvik p plenth px' })]);
    const out = diversify(input, options());
    expect(ids(out.hits)).toEqual(['p', 'q', 'r']);
    expect(out.counts.collapsed).toBe(0);
  });

  it('lists a document once when two dropped chunks of the cluster share it, and never the kept chunk own document', () => {
    const input = descending([
      row('k', { cluster: 'Y', doc: 'd-1' }),
      row('m1', { cluster: 'Y', doc: 'd-2' }),
      row('m2', { cluster: 'Y', doc: 'd-2' }),
      row('m3', { cluster: 'Y', doc: 'd-1' }),
    ]);
    const out = diversify(input, options());
    expect(ids(out.hits)).toEqual(['k']);
    expect(out.alsoIn.get('k')).toEqual([{ documentId: 'd-2', filename: 'd-2.txt', chunkId: 'm1' }]);
  });

  it('mmr with lambda 1 equals collapse', () => {
    const collapse = diversify(flooded(), options());
    const mmr = diversify(flooded(), options({ mode: 'mmr', lambda: 1 }));
    expect(ids(mmr.hits)).toEqual(ids(collapse.hits));
    expect(mmr.alsoIn).toEqual(collapse.alsoIn);
    expect(mmr.counts.mmr_moved).toBe(0);
  });

  it('mmr with lambda 0.5 moves a token-identical candidate below a less relevant different one', () => {
    const input = descending([
      row('s1', { content: 'quillon brask vemmet torrin' }),
      row('s2', { content: 'quillon brask vemmet torrin' }),
      row('s3', { content: 'yarrow plinth oskel fadrum' }),
    ]);
    const out = diversify(input, options({ mode: 'mmr', lambda: 0.5 }));
    expect(ids(out.hits)).toEqual(['s1', 's3', 's2']);
    expect(out.counts.mmr_moved).toBe(2);
  });

  it('is deterministic and breaks ties by original index', () => {
    const tied = [row('t1'), row('t2'), row('t3'), row('t4')];
    const first = diversify(tied, options({ mode: 'mmr', lambda: 0.5 }));
    const second = diversify(tied, options({ mode: 'mmr', lambda: 0.5 }));
    expect(ids(first.hits)).toEqual(ids(second.hits));
    expect(ids(first.hits)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('reads the rerank score as relevance when given, else the fused score', () => {
    const input = descending([
      row('r1', { content: 'quillon brask vemmet torrin' }),
      row('r2', { content: 'yarrow plinth oskel fadrum' }),
      row('r3', { content: 'quillon brask vemmet torrin' }),
    ]);
    const relevanceByChunk = new Map([
      ['r1', 0.9],
      ['r2', 0.1],
      ['r3', 0.89],
    ]);
    const fused = diversify(input, options({ mode: 'mmr', lambda: 0.7 }));
    const reranked = diversify(input, options({ mode: 'mmr', lambda: 0.7, relevanceByChunk }));
    expect(ids(fused.hits)).toEqual(['r1', 'r2', 'r3']);
    expect(ids(reranked.hits)).toEqual(['r1', 'r3', 'r2']);
  });

  it('does not divide by zero on a window of one or on equal scores', () => {
    const single = diversify([row('only', { score: 0.4 })], options({ mode: 'mmr' }));
    expect(ids(single.hits)).toEqual(['only']);
    const equal = diversify([row('e1', { score: 0.3 }), row('e2', { score: 0.3 })], options({ mode: 'mmr' }));
    expect(ids(equal.hits)).toEqual(['e1', 'e2']);
  });

  it('reorders only the window of windowFactor times finalTopK and keeps the rest in order', () => {
    const same = 'quillon brask vemmet torrin';
    const input = descending([
      row('w1', { content: same }),
      row('w2', { content: same }),
      row('w3', { content: 'yarrow plinth oskel fadrum' }),
      row('w4', { content: same }),
      row('w5', { content: 'cendril maunt' }),
    ]);
    const out = diversify(input, options({ mode: 'mmr', lambda: 0.5, windowFactor: 1, finalTopK: 3 }));
    expect(ids(out.hits)).toEqual(['w1', 'w3', 'w2', 'w4', 'w5']);
  });

  it('never drops the only chunk of a sub-question', () => {
    const input = descending([
      row('g1', { cluster: 'Z', doc: 'd-g1' }),
      row('g2', { cluster: 'Z', doc: 'd-g2' }),
      row('g3', { cluster: 'Z', doc: 'd-g3' }),
    ]);
    const tags = new Map<string, number[]>([
      ['g1', [0]],
      ['g2', [1]],
      ['g3', [0]],
    ]);
    const out = diversify(input, options({ subQuestionOf: (entry) => tags.get(entry.hit.chunkId) ?? [] }));
    expect(ids(out.hits)).toEqual(['g1', 'g2']);
    expect(out.alsoIn.get('g1')).toEqual([{ documentId: 'd-g3', filename: 'd-g3.txt', chunkId: 'g3' }]);
  });

  it('with no sub-question tags the guard changes nothing', () => {
    const untagged = diversify(flooded(), options());
    const tagless = diversify(flooded(), options({ subQuestionOf: () => [] }));
    expect(ids(tagless.hits)).toEqual(ids(untagged.hits));
    expect(tagless.alsoIn).toEqual(untagged.alsoIn);
  });
});
