import type { BudgetCandidate, BudgetOptions, BudgetResult, RenderEstimate } from './budget';

export interface PackCandidate extends Omit<BudgetCandidate, 'rank'> {
  parent_id?: string | null;
  rerank_score?: number | null;
  fused_score?: number | null;
  similarity?: number | null;
}

export interface PackOptions extends BudgetOptions {
  order?: 'score' | 'input';
}

export interface PackResult<C extends BudgetCandidate> extends BudgetResult<C> {
  documentBudget: number;
  droppedDocuments: number;
  keptParents: number;
}

export function documentBudgetOf(_value: unknown): number | null {
  return null;
}

export function packByRank<C extends PackCandidate>(
  _candidates: C[],
  budget: number,
  _renderEstimate: RenderEstimate<C & { rank: number }>,
  _options: PackOptions,
): PackResult<C & { rank: number }> {
  return { selected: [], contentOverrides: new Map(), usedTokens: 0, documentBudget: budget, droppedDocuments: 0, keptParents: 0 };
}
