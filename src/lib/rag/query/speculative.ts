import type { BackendLegs, BackendSearchRequest, RetrievalFilters } from '../backend/types';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import type { TenantScope } from '../tenant/scope';
import type { QueryVariant, SpeculativeTrace, StageRecord } from '../types';
import { transformSignal } from './deadline';

export interface SpeculativeSearchOutcome {
  legs: BackendLegs;
  /** The request the speculative search sent; adoption compares it with the one the search stage would send. */
  request: BackendSearchRequest;
}

/** What the pipeline lends the speculation: the same embed call and search request the embed and search stages would make. */
export interface SpeculativeDeps {
  embed(text: string, signal: AbortSignal): Promise<QueryEmbedding>;
  search(args: { scope: TenantScope; text: string; embedding: QueryEmbedding; filters: RetrievalFilters; signal: AbortSignal }): Promise<SpeculativeSearchOutcome>;
  now(): number;
}

/** The pipeline's side of the seam: runQueryStages adds the base filters, run-layer starts the speculation. */
export interface SpeculativeSeam {
  deps: SpeculativeDeps;
  /** Told the handle as soon as it starts, so the pipeline can abort it on any exit. */
  onStart(handle: SpeculativeHandle): void;
  embedTimeoutMs: number | null;
  searchTimeoutMs: number | null;
}

export type SpeculativeAbortReason = 'cache_hit' | 'request_end';

export interface SpeculativeHandle {
  readonly text: string;
  readonly filters: RetrievalFilters;
  readonly startedAt: number;
  /** Never rejects: null when the embedding failed, timed out or was aborted. */
  readonly embedding: Promise<QueryEmbedding | null>;
  /** Never rejects: null when the embedding or the search failed, timed out or was aborted. */
  readonly promise: Promise<SpeculativeSearchOutcome | null>;
  abort(reason: SpeculativeAbortReason): void;
  /** The end of condense and the parallel group; overlap is measured up to here. */
  markTransformsEnded(): void;
  /**
   * Single use: the legs when the speculative request equals `request` (signal aside), else null and the search counts as
   * wasted. A failed speculation returns null too.
   */
  take(request: BackendSearchRequest): Promise<BackendLegs | null>;
  /** The results will not be used (out_of_scope, a path that cannot adopt them); counted as wasted when a search was sent. */
  discard(): void;
  trace(requestStartedAt: number): SpeculativeTrace;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, index) => sameValue(value, other[index]));
  }
  const left = Object.entries(a as Record<string, unknown>).filter(([, value]) => value !== undefined);
  const right = Object.entries(b as Record<string, unknown>).filter(([, value]) => value !== undefined);
  if (left.length !== right.length) return false;
  const rightMap = new Map(right);
  return left.every(([key, value]) => rightMap.has(key) && sameValue(value, rightMap.get(key)));
}

/** P-29, T-06.2-67: the speculative search is adopted only when every request field but the signal is equal. */
export function sameSearchRequest(a: BackendSearchRequest, b: BackendSearchRequest): boolean {
  if (a.scope !== b.scope) return false;
  const { signal: _a, scope: _sa, ...left } = a;
  const { signal: _b, scope: _sb, ...right } = b;
  return sameValue(left, right);
}

/**
 * D-21, P-29: embeds and searches the original query outside runStage while condense and the parallel group run. Its own
 * AbortController joins the request signal through AbortSignal.any; every promise has its catch attached here, so an aborted
 * or failed speculation never becomes an unhandled rejection and never writes a stage record.
 */
export function startSpeculativeRetrieval(args: {
  text: string;
  filters: RetrievalFilters;
  scope: TenantScope;
  signal: AbortSignal;
  deps: SpeculativeDeps;
  embedTimeoutMs?: number | null;
  searchTimeoutMs?: number | null;
}): SpeculativeHandle {
  const { text, filters, scope, deps } = args;
  const controller = new AbortController();
  const signal = AbortSignal.any([args.signal, controller.signal]);
  const startedAt = deps.now();
  let endedAt: number | null = null;
  let transformsEndedAt: number | null = null;
  let searchSent = false;
  let state: 'pending' | 'adopted' | 'discarded' = 'pending';
  let wasted = 0;
  let cancelledByCache = false;

  const embedding: Promise<QueryEmbedding | null> = Promise.resolve()
    .then(() => deps.embed(text, transformSignal(signal, null, args.embedTimeoutMs ?? null)))
    .then(
      (value) => value,
      () => null,
    );
  const promise: Promise<SpeculativeSearchOutcome | null> = embedding
    .then(async (vector) => {
      if (!vector || signal.aborted) return null;
      searchSent = true;
      return deps.search({ scope, text, embedding: vector, filters, signal: transformSignal(signal, null, args.searchTimeoutMs ?? null) });
    })
    .then(
      (outcome) => {
        endedAt = deps.now();
        return outcome;
      },
      () => {
        endedAt = deps.now();
        return null;
      },
    );

  const waste = () => {
    if (state !== 'pending') return;
    state = 'discarded';
    if (searchSent) wasted += 1;
  };

  return {
    text,
    filters,
    startedAt,
    embedding,
    promise,
    abort(reason) {
      if (reason === 'cache_hit' && state === 'pending') cancelledByCache = true;
      if (!controller.signal.aborted) controller.abort(new DOMException(`speculative retrieval ${reason}`, 'AbortError'));
    },
    markTransformsEnded() {
      transformsEndedAt ??= deps.now();
    },
    async take(request) {
      if (state !== 'pending') return null;
      const outcome = await promise;
      if (state !== 'pending') return null;
      if (outcome && sameSearchRequest(outcome.request, request)) {
        state = 'adopted';
        return outcome.legs;
      }
      waste();
      return null;
    },
    discard() {
      waste();
      if (!controller.signal.aborted) controller.abort(new DOMException('speculative retrieval discarded', 'AbortError'));
    },
    trace(requestStartedAt) {
      // A speculation nobody adopted by the end of the request was wasted work.
      if (state === 'pending') waste();
      const overlapEnd = Math.min(endedAt ?? deps.now(), transformsEndedAt ?? deps.now());
      return {
        started_ms: Math.max(0, startedAt - requestStartedAt),
        overlap_ms: Math.max(0, overlapEnd - startedAt),
        cancelled_by_cache: cancelledByCache,
        wasted_searches: wasted,
      };
    },
  };
}

/** The original variant as runQueryStages builds it (buildQueryVariantSet): text and language only, no dense suffix. */
export function speculativeVariant(text: string, language: string | null): QueryVariant {
  return { text, language, kind: 'original' };
}

/**
 * D-37, P-09: pre-retrieval time is request start to the end of fuse, for every turn; null when no fuse stage ran
 * (small talk, cache hit, out_of_scope, a failure before fusion).
 */
export function preRetrievalMs(stages: readonly StageRecord[], requestStartedAt: number): number | null {
  const fuse = stages.find((row) => row.name === 'fuse');
  return fuse ? Math.max(0, fuse.endedAt - requestStartedAt) : null;
}

/** D-37: the split of the comparison: did the transforms add any variant beyond the original? */
export function transformsProducedNewVariant(variants: ReadonlyArray<{ kind: string }> | null | undefined): boolean {
  return (variants ?? []).some((variant) => variant.kind !== 'original');
}
