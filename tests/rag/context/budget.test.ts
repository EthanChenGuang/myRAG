import { describe, expect, it } from 'vitest';
import { countContextTokens, selectWithinBudget, type BudgetCandidate, type RenderEstimate } from '@/lib/rag/context/budget';

const BODY = 'neutral sample sentence for budget checks. '.repeat(10);
const render: RenderEstimate = (candidate) => candidate.content;
const options = { imageExtensions: ['.png'] };

function candidate(rank: number, overrides: Partial<BudgetCandidate> = {}): BudgetCandidate {
  return { rank, chunk_id: `c${rank}`, document_id: `d${rank}`, document_filename: `doc-${rank}.txt`, content: BODY, ...overrides };
}

describe('selectWithinBudget (pinned before packByRank reuses it)', () => {
  const unit = countContextTokens(BODY);

  it('keeps candidates in rank order until the budget is reached', () => {
    const result = selectWithinBudget([candidate(3), candidate(1), candidate(2)], unit * 2, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.usedTokens).toBe(unit * 2);
    expect(result.contentOverrides.size).toBe(0);
  });

  it('truncates the first-ranked candidate when it alone exceeds the budget', () => {
    const result = selectWithinBudget([candidate(1), candidate(2)], 5, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1']);
    const truncated = result.contentOverrides.get('c1');
    expect(truncated).toBeDefined();
    expect(countContextTokens(truncated!)).toBeLessThanOrEqual(5);
  });

  it('keeps the first-ranked candidate truncated with a zero budget', () => {
    const result = selectWithinBudget([candidate(1)], 0, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1']);
    expect(result.contentOverrides.has('c1')).toBe(true);
  });

  it('always keeps image documents, outside the budget', () => {
    const image = candidate(2, { document_filename: 'figure.PNG' });
    const result = selectWithinBudget([candidate(1), image, candidate(3)], unit, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c2']);
    expect(result.usedTokens).toBe(unit);
  });

  it('skips a block that does not fit and keeps a later one that does', () => {
    const big = candidate(2, { content: BODY.repeat(3) });
    const small = candidate(3, { content: 'short neutral line.' });
    const result = selectWithinBudget([candidate(1), big, small], unit + 10, render, options);
    expect(result.selected.map((entry) => entry.chunk_id)).toEqual(['c1', 'c3']);
  });
});
