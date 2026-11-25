export type RerankProviderId = 'cohere' | 'voyage' | 'local_bm25';

export type RerankTier = 'fast' | 'quality';

export type RerankScoreSemantics = 'calibrated' | 'relative';

export interface RerankSpan {
  start: number;
  end: number;
  score: number;
}

export interface RerankScore {
  index: number;
  score: number;
  spans?: RerankSpan[];
}

export interface RerankOptions {
  topN?: number;
  timeoutMs?: number;
  signal: AbortSignal;
  wantSpans?: boolean;
  queryByDoc?: string[];
}

export interface Reranker {
  readonly id: RerankProviderId;
  readonly model: string;
  readonly scoreSemantics: RerankScoreSemantics;
  /** Registry codes this adapter is declared for (D-07); the language validator refuses a set it lacks. */
  readonly supportedLanguages: readonly string[];
  rerank(
    query: string,
    docs: string[],
    opts: RerankOptions,
  ): Promise<{ scores: RerankScore[]; usage?: Record<string, number> }>;
}

/** Part of retrieval config hash and refusal threshold cells (A-11). */
export const RERANK_TEXT_VERSION = 1;