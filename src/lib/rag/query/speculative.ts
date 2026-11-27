import type { BackendLegs, BackendSearchRequest, RetrievalFilters } from '../backend/types';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import type { TenantScope } from '../tenant/scope';
import type { SpeculativeTrace } from '../types';

export interface SpeculativeSearchOutcome {
  legs: BackendLegs;
  request: BackendSearchRequest;
}

export interface SpeculativeDeps {
  embed(text: string, signal: AbortSignal): Promise<QueryEmbedding>;
  search(args: { scope: TenantScope; text: string; embedding: QueryEmbedding; filters: RetrievalFilters; signal: AbortSignal }): Promise<SpeculativeSearchOutcome>;
  now(): number;
}

export interface SpeculativeHandle {
  readonly text: string;
  readonly filters: RetrievalFilters;
  readonly startedAt: number;
  readonly embedding: Promise<QueryEmbedding | null>;
  readonly promise: Promise<SpeculativeSearchOutcome | null>;
  abort(reason: 'cache_hit' | 'request_end'): void;
  trace(requestStartedAt: number): SpeculativeTrace;
}

export function startSpeculativeRetrieval(_args: {
  text: string;
  filters: RetrievalFilters;
  scope: TenantScope;
  signal: AbortSignal;
  deps: SpeculativeDeps;
}): SpeculativeHandle {
  throw new Error('not implemented');
}
