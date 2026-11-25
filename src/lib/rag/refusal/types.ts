export type RefusalDecision = 'refuse' | 'answer' | 'not_applied';

export type RefusalBasis = 'rerank_threshold' | 'similarity_floor' | 'none';

export interface RefusalRecord {
  decision: RefusalDecision;
  basis: RefusalBasis;
  reason:
    | 'switch_off'
    | 'reranker_disabled'
    | 'reranker_unavailable'
    | 'relative_scores'
    | 'no_candidates'
    | 'invalid_score'
    | 'cell_uncalibrated'
    | 'cell_stale'
    | 'no_dense_similarity'
    | (string & {});
  topScore: number | null;
  threshold: number | null;
  cellKey: string | null;
}