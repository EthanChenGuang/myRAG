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

/** 04.4-21 D-55: one tenant's compacted statistics for one candidate group (the chunk's effective chunking profile and language). */
export interface LocalStatsGroup {
  chunkCount: number;
  totalLength: number;
  /** df per asked term; a term without a counter is absent (the scorer clamps it to 1, D-20). */
  df: ReadonlyMap<string, number>;
}

/**
 * 04.4-21 D-55: injected by the rank stage only under RAG_RERANK_LOCAL_STATS=tenant, so the reranker module never imports Supabase.
 * groupByDoc names each document's group (null: the document has none, so the pool serves the request).
 */
export interface LocalStatsProvider {
  readonly groupByDoc: ReadonlyArray<string | null>;
  /** One read per rerank call for every query term and group; null on a failure, a timeout or a tenant without ready statistics. */
  read(terms: string[], groups: string[], signal: AbortSignal): Promise<ReadonlyMap<string, LocalStatsGroup> | null>;
}

export interface RerankOptions {
  topN?: number;
  timeoutMs?: number;
  signal: AbortSignal;
  wantSpans?: boolean;
  queryByDoc?: string[];
  /** local_bm25 only; absent means pool statistics (today's scoring). */
  localStats?: LocalStatsProvider;
}

/** 04.4-21: which statistics served a local_bm25 call that was given a provider; absent when no provider was given. */
export type LocalStatsSource = 'tenant' | 'pool';

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
  ): Promise<{ scores: RerankScore[]; usage?: Record<string, number>; localStats?: LocalStatsSource; model?: string }>;
}

/** Part of retrieval config hash and refusal threshold cells (A-11). */
export const RERANK_TEXT_VERSION = 1;