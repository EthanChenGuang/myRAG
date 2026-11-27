import { selectWithinBudget, type BudgetCandidate, type BudgetOptions, type BudgetResult, type RenderEstimate } from './budget';

export interface PackCandidate extends Omit<BudgetCandidate, 'rank'> {
  parent_id?: string | null;
  rerank_score?: number | null;
  fused_score?: number | null;
  similarity?: number | null;
}

export interface PackOptions extends BudgetOptions {
  /** 'score' (default) ranks by D-83's key; 'input' keeps the caller's order (the voice results are already ranked). */
  order?: 'score' | 'input';
}

export interface PackResult<C extends BudgetCandidate> extends BudgetResult<C> {
  documentBudget: number;
  droppedDocuments: number;
  keptParents: number;
}

/** A finite budget as a non-negative integer; anything else reads as absent, so the assembly stays as it is. */
export function documentBudgetOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** D-83: rerank score first, then fused score for items without one, then similarity; ties keep the input order. */
function tierOf(candidate: PackCandidate): [number, number] {
  if (finite(candidate.rerank_score)) return [0, candidate.rerank_score];
  if (finite(candidate.fused_score)) return [1, candidate.fused_score];
  return [2, finite(candidate.similarity) ? candidate.similarity : Number.NEGATIVE_INFINITY];
}

/** The packing unit: one parent per document, else the chunk itself. */
export function packUnitKey(candidate: Pick<PackCandidate, 'chunk_id' | 'document_id' | 'parent_id'>): string {
  return candidate.parent_id ? `p:${candidate.document_id}:${candidate.parent_id}` : `c:${candidate.chunk_id}`;
}

/**
 * D-83: rank, deduplicate by parent (the higher-ranked child represents it) and pack to the budget through selectWithinBudget,
 * which keeps the first-ranked block truncated when nothing fits and always keeps image documents.
 */
export function packByRank<C extends PackCandidate>(
  candidates: C[],
  budget: number,
  renderEstimate: RenderEstimate<C & { rank: number }>,
  options: PackOptions,
): PackResult<C & { rank: number }> {
  const indexed = candidates.map((candidate, index) => ({ candidate, index, tier: tierOf(candidate) }));
  if ((options.order ?? 'score') === 'score') {
    indexed.sort((x, y) => x.tier[0] - y.tier[0] || y.tier[1] - x.tier[1] || x.index - y.index);
  }
  const seen = new Set<string>();
  const ranked: Array<C & { rank: number }> = [];
  for (const { candidate } of indexed) {
    const key = packUnitKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push({ ...candidate, rank: ranked.length + 1 });
  }
  const result = selectWithinBudget<C & { rank: number }>(ranked, budget, renderEstimate, { imageExtensions: options.imageExtensions });
  return {
    ...result,
    documentBudget: budget,
    droppedDocuments: ranked.length - result.selected.length,
    keptParents: result.selected.length,
  };
}
