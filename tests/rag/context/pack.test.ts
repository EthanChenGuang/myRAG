import { describe, expect, it } from 'vitest';
import { countContextTokens, type RenderEstimate } from '@/lib/rag/context/budget';
import { documentBudgetOf, packByRank, type PackCandidate } from '@/lib/rag/context/pack';

const BODY = 'neutral sample sentence for packing checks. '.repeat(8);
const UNIT = countContextTokens(BODY);
const render: RenderEstimate<PackCandidate & { rank: number }> = (candidate) => candidate.content;
const options = { imageExtensions: ['.png'] };

function block(id: string, scores: Partial<PackCandidate> = {}): PackCandidate {
  return { chunk_id: id, document_id: `doc-${id}`, document_filename: `${id}.txt`, content: BODY, similarity: 0.5, ...scores };
}

const FIVE: PackCandidate[] = [
  block('a', { rerank_score: 0.9, fused_score: 0.1, similarity: 0.1 }),
  block('b', { rerank_score: 0.2, fused_score: 0.9, similarity: 0.9 }),
  block('c', { rerank_score: 0.7 }),
  block('d', { rerank_score: null, fused_score: 0.8, similarity: 0.95 }),
  block('e', { rerank_score: 0.5 }),
];

describe('packByRank', () => {
  it('orders by rerank score, then fused score for unscored items, then similarity', () => {
    const tail = [block('f', { similarity: 0.99 }), block('g', { fused_score: 0.05, similarity: 0.01 })];
    const result = packByRank([...FIVE, ...tail], UNIT * 100, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a', 'c', 'e', 'b', 'd', 'g', 'f']);
    expect(result.selected.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.droppedDocuments).toBe(0);
    expect(result.keptParents).toBe(7);
  });

  it('keeps the three highest-ranked blocks when the budget fits three', () => {
    const result = packByRank(FIVE, UNIT * 3, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a', 'c', 'e']);
    expect(result.droppedDocuments).toBe(2);
    expect(result.keptParents).toBe(3);
    expect(result.documentBudget).toBe(UNIT * 3);
  });

  it('counts two children of one parent once, represented by the higher-ranked child', () => {
    const children = [
      block('low', { parent_id: 'p1', document_id: 'doc-p', rerank_score: 0.3 }),
      block('high', { parent_id: 'p1', document_id: 'doc-p', rerank_score: 0.8 }),
      block('other', { rerank_score: 0.6 }),
    ];
    const result = packByRank(children, UNIT * 100, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['high', 'other']);
    expect(result.keptParents).toBe(2);
    expect(result.droppedDocuments).toBe(0);
  });

  it('keeps the input order with order "input"', () => {
    const result = packByRank(FIVE, UNIT * 2, render, { ...options, order: 'input' });
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a', 'b']);
    expect(result.droppedDocuments).toBe(3);
  });

  it('keeps the first-ranked block truncated when nothing fits', () => {
    const result = packByRank(FIVE, 4, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['a']);
    expect(result.contentOverrides.has('a')).toBe(true);
    expect(result.droppedDocuments).toBe(4);
  });
});

describe('documentBudgetOf', () => {
  it('reads a finite budget as a non-negative integer and anything else as absent', () => {
    expect(documentBudgetOf(undefined)).toBeNull();
    expect(documentBudgetOf(Number.NaN)).toBeNull();
    expect(documentBudgetOf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(documentBudgetOf('100')).toBeNull();
    expect(documentBudgetOf(-5)).toBe(0);
    expect(documentBudgetOf(120.7)).toBe(120);
  });
});
