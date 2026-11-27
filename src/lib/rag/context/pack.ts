import type { PackingSummary } from '../types';
import type { AssemblyCandidate, AssemblyDocumentRow, FilteredCandidates } from './assemble';
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

/** The block estimate the v2 assembly uses: the document header once per document, the GPT source line, the text. */
export function blockRenderEstimate(isGPTModel: boolean): RenderEstimate<BudgetCandidate> {
  return (candidate, { addsDocumentHeader }) => {
    const header = addsDocumentHeader ? `\n--- Document: ${candidate.document_filename} (1 relevant chunks) ---\n\n` : '';
    const label = isGPTModel ? `[Source: ${candidate.document_filename}]\n` : '';
    return `${header}${label}${candidate.content}`;
  };
}

type LegacyPackCandidate = AssemblyCandidate & Pick<PackCandidate, 'parent_id' | 'rerank_score' | 'fused_score'>;

export interface PackedFiltered<C extends LegacyPackCandidate> {
  state: FilteredCandidates<C>;
  candidates: C[];
  summary: PackingSummary;
}

/**
 * D-83, D-95: the legacy assembly packs its relevant chunks before buildContext, so the labeller only sees kept blocks. Kept chunks
 * render in their legacy order; a used document with no kept chunk leaves the sources unless it was explicitly referenced.
 */
export function packFiltered<C extends LegacyPackCandidate>(
  state: FilteredCandidates<C>,
  candidates: C[],
  documents: ReadonlyMap<string, AssemblyDocumentRow>,
  budget: number,
  options: { isGPTModel: boolean; imageExtensions: string[] },
): PackedFiltered<C> {
  const units = state.relevantChunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    document_filename: documents.get(chunk.document_id)?.filename ?? 'Unknown Document',
    content: chunk.content,
    parent_id: chunk.parent_id ?? null,
    rerank_score: chunk.rerank_score ?? null,
    fused_score: chunk.fused_score ?? null,
    similarity: chunk.similarity,
  }));
  const packed = packByRank(units, budget, blockRenderEstimate(options.isGPTModel), { imageExtensions: options.imageExtensions });
  const keptIds = new Set(packed.selected.map((entry) => entry.chunk_id));
  const relevantIds = new Set(state.relevantChunks.map((chunk) => chunk.chunk_id));
  const withOverride = (chunk: C): C => {
    const content = packed.contentOverrides.get(chunk.chunk_id);
    return content === undefined ? chunk : { ...chunk, content };
  };
  const relevantChunks = state.relevantChunks.filter((chunk) => keptIds.has(chunk.chunk_id)).map(withOverride);
  const keptDocuments = new Set(relevantChunks.map((chunk) => chunk.document_id));
  return {
    state: {
      ...state,
      relevantChunks,
      usedDocuments: state.usedDocuments.filter((doc) => doc.explicitly_referenced || keptDocuments.has(doc.id)),
    },
    candidates: candidates.filter((chunk) => !relevantIds.has(chunk.chunk_id) || keptIds.has(chunk.chunk_id)).map(withOverride),
    summary: { documentBudget: packed.documentBudget, droppedDocuments: packed.droppedDocuments, keptParents: packed.keptParents },
  };
}
