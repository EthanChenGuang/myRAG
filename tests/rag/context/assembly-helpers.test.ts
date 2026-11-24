import { describe, expect, it } from 'vitest';
import { countContextTokens, selectWithinBudget, type BudgetCandidate } from '@/lib/rag/context/budget';
import { edgeOrder } from '@/lib/rag/context/edge-order';
import { mergeAdjacent, type AdjacentChunk } from '@/lib/rag/context/merge-adjacent';
import { countTokens, truncateToTokens } from '@/lib/rag/ingest/text/tokens';

describe('edgeOrder', () => {
  it('interleaves odds then evens reversed', () => {
    expect(edgeOrder([1, 2, 3, 4, 5, 6])).toEqual([1, 3, 5, 6, 4, 2]);
  });

  it('returns empty for empty input', () => {
    expect(edgeOrder([])).toEqual([]);
  });

  it('returns a single element unchanged', () => {
    expect(edgeOrder([1])).toEqual([1]);
  });
});

function chunk(
  partial: Partial<AdjacentChunk> & Pick<AdjacentChunk, 'document_id' | 'chunk_index' | 'rank'>,
): AdjacentChunk {
  return {
    chunk_id: `${partial.document_id}-${partial.chunk_index}`,
    parent_id: null,
    ...partial,
  };
}

function budgetCandidate(
  partial: Partial<BudgetCandidate> & Pick<BudgetCandidate, 'rank' | 'chunk_id' | 'content'>,
): BudgetCandidate {
  return {
    document_id: 'doc-1',
    document_filename: 'notes.md',
    ...partial,
  };
}

describe('mergeAdjacent', () => {
  it('groups by document, merges consecutive indices into runs, orders by best rank', () => {
    const input = [
      chunk({ document_id: 'doc-A', chunk_index: 3, rank: 1 }),
      chunk({ document_id: 'doc-B', chunk_index: 1, rank: 2 }),
      chunk({ document_id: 'doc-A', chunk_index: 4, rank: 3 }),
      chunk({ document_id: 'doc-A', chunk_index: 9, rank: 4 }),
    ];
    const groups = mergeAdjacent(input);
    expect(groups.map((g) => g.documentId)).toEqual(['doc-A', 'doc-B']);
    expect(groups[0]!.rank).toBe(1);
    expect(groups[1]!.rank).toBe(2);
    expect(groups[0]!.runs.map((run) => run.map((c) => c.chunk_index))).toEqual([[3, 4], [9]]);
  });

  it('merges children with the same parent id into one run', () => {
    const input = [
      chunk({ document_id: 'doc-A', chunk_index: 1, rank: 1, parent_id: 'p1' }),
      chunk({ document_id: 'doc-A', chunk_index: 5, rank: 2, parent_id: 'p1' }),
    ];
    const groups = mergeAdjacent(input);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.runs).toHaveLength(1);
    expect(groups[0]!.runs[0]!.map((c) => c.chunk_index)).toEqual([1, 5]);
  });
});

describe('selectWithinBudget', () => {
  const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

  function renderEstimate(candidate: BudgetCandidate, ctx: { addsDocumentHeader: boolean }): string {
    const header = ctx.addsDocumentHeader ? `--- Document: ${candidate.document_filename} ---\n` : '';
    return header + candidate.content;
  }

  it('keeps rank-1 and as many further chunks as fit under the budget', () => {
    const text = 'word '.repeat(20).trim();
    const candidates: BudgetCandidate[] = [
      budgetCandidate({ rank: 1, chunk_id: 'c1', content: text }),
      budgetCandidate({ rank: 2, chunk_id: 'c2', content: text, document_id: 'doc-2', document_filename: 'b.md' }),
      budgetCandidate({ rank: 3, chunk_id: 'c3', content: text, document_id: 'doc-3', document_filename: 'c.md' }),
    ];
    const first = countTokens(renderEstimate(candidates[0]!, { addsDocumentHeader: true }));
    const second = countTokens(renderEstimate(candidates[1]!, { addsDocumentHeader: true }));
    const budget = first + Math.floor(second / 2);
    const result = selectWithinBudget(candidates, budget, renderEstimate, { imageExtensions: IMAGE_EXTENSIONS });
    expect(result.selected.map((c) => c.chunk_id)).toEqual(['c1']);
    expect(result.usedTokens).toBeLessThanOrEqual(budget);
  });

  it('truncates an over-budget rank-1 chunk when it is alone', () => {
    const long = 'x'.repeat(500);
    const candidates = [budgetCandidate({ rank: 1, chunk_id: 'c1', content: long })];
    const budget = 50;
    const result = selectWithinBudget(candidates, budget, renderEstimate, { imageExtensions: IMAGE_EXTENSIONS });
    expect(result.selected).toHaveLength(1);
    const override = result.contentOverrides?.get('c1');
    expect(override).toBeTruthy();
    expect(countTokens(override!)).toBeLessThanOrEqual(budget);
    expect(long.startsWith(override!.slice(0, 10))).toBe(true);
  });

  it('keeps image-document chunks without counting them toward the budget', () => {
    const candidates: BudgetCandidate[] = [
      budgetCandidate({ rank: 1, chunk_id: 'c1', content: 'ignored-for-budget', document_filename: 'photo.png' }),
      budgetCandidate({
        rank: 2,
        chunk_id: 'c2',
        content: 'fit',
        document_id: 'doc-2',
        document_filename: 'notes.md',
      }),
      budgetCandidate({
        rank: 3,
        chunk_id: 'c3',
        content: 'z'.repeat(2000),
        document_id: 'doc-3',
        document_filename: 'big.md',
      }),
    ];
    const budget = 10;
    const result = selectWithinBudget(candidates, budget, renderEstimate, { imageExtensions: IMAGE_EXTENSIONS });
    expect(result.selected.map((c) => c.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.usedTokens).toBeLessThanOrEqual(budget);
  });
});

describe('countContextTokens', () => {
  it('matches cl100k_base token counting from ingest', () => {
    const text = 'Hello, RAG context budget.';
    expect(countContextTokens(text)).toBe(countTokens(text));
  });
});

describe('countContextTokens shared encoder', () => {
  it('returns stable counts across budget selections', () => {
    const candidates = [
      budgetCandidate({ rank: 1, chunk_id: 'c1', content: 'alpha bravo' }),
      budgetCandidate({ rank: 2, chunk_id: 'c2', content: 'charlie', document_id: 'd2', document_filename: 'b.md' }),
    ];
    const render = (c: BudgetCandidate) => c.content;
    const narrow = selectWithinBudget(candidates, 5, render, { imageExtensions: ['.png'] });
    const wide = selectWithinBudget(candidates, 500, render, { imageExtensions: ['.png'] });
    expect(narrow.selected.length).toBeLessThanOrEqual(wide.selected.length);
    expect(countContextTokens('alpha bravo')).toBe(countTokens('alpha bravo'));
  });
});