import { randomBytes } from 'node:crypto';
import { getRagDeps } from '../deps';
import type { Profile, StageFailureReason, StageRecord, StageRunStatus } from '../types';

const TRACE_ID = /^[0-9a-f]{32}$/;

const CACHE_STATES: ReadonlySet<string> = new Set<TraceCacheState>(['hit', 'miss', 'bypass']);

/** True for a 32-character lowercase hex trace id, the shape every collector produces. */
export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value);
}

const STAGE_COUNT_KEY = /^[a-z][a-z0-9_]{0,63}$/;

export function sanitizeStageCounts(raw: Record<string, number>): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!STAGE_COUNT_KEY.test(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    counts[key] = value;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

export interface StageEntry {
  name: string;
  status: StageRunStatus;
  reason?: StageFailureReason | 'disabled';
  startedAt: number;
  endedAt: number;
  candidatesIn?: number | null;
  candidatesOut?: number | null;
  counts?: Record<string, number>;
  rules?: string[];
  /** Detector versions such as rules@<12 hex>. */
  versions?: string[];
  detail?: string;
}

export interface ReviewContent {
  query?: string;
  answer?: string;
  context?: string;
  model?: string;
}

/** Whether the answer came from the semantic cache; `bypass` when no cache lookup applied. */
export type TraceCacheState = 'hit' | 'miss' | 'bypass';

/** D-25: request timing in milliseconds from the route's receipt time; numbers and one fixed word only. */
export interface TraceTiming {
  pre_generation_ms?: number;
  ttft_ms?: number;
  cache: TraceCacheState;
}

/** The retrieval profiles plus `ingest`, the profile of an ingestion trace. */
export type TraceProfile = Profile | 'ingest';

export interface TraceCollector {
  readonly traceId: string;
  readonly profile: TraceProfile;
  readonly tenantKey: string;
  readonly startedAt: number;
  now(): number;
  record(entry: StageEntry): StageRecord;
  stages(): StageRecord[];
  toStageLatency(): Record<string, number>;
  toStageStatus(): Record<string, StageRunStatus>;
  setReviewContent(content: ReviewContent): void;
  reviewContent(): ReviewContent | null;
  /** The route's receipt time; `startedAt` is retrieval start. Defaults to the clock. */
  markRequestStart(at?: number): void;
  markGenerationStart(): void;
  markFirstTextDelta(): void;
  setCacheState(state: TraceCacheState): void;
  /** Null until a request start was marked, so a request that records no timing exports what it exported before. */
  timing(): TraceTiming | null;
}

export interface TraceCollectorOptions {
  profile: TraceProfile;
  tenantKey: string;
}

function normaliseTraceId(raw: string): string {
  const candidate = raw.replace(/-/g, '').toLowerCase();
  return TRACE_ID.test(candidate) ? candidate : randomBytes(16).toString('hex');
}

export function createTraceCollector(options: TraceCollectorOptions): TraceCollector {
  const deps = getRagDeps();
  const records: StageRecord[] = [];
  const traceId = normaliseTraceId(deps.randomId());
  const startedAt = deps.now();
  let review: ReviewContent | null = null;
  let requestStart: number | null = null;
  let preGenerationMs: number | null = null;
  let ttftMs: number | null = null;
  let cacheState: TraceCacheState = 'bypass';
  const elapsedSince = (start: number): number => {
    const elapsed = deps.now() - start;
    return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  };

  return {
    traceId,
    profile: options.profile,
    tenantKey: options.tenantKey,
    startedAt,
    now: () => deps.now(),
    record(entry) {
      const record: StageRecord = {
        name: entry.name,
        status: entry.status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        latency_ms: Math.max(0, entry.endedAt - entry.startedAt),
        candidates_in: entry.candidatesIn ?? null,
        candidates_out: entry.candidatesOut ?? null,
        rules: entry.rules ?? [],
      };
      if (entry.reason !== undefined) record.reason = entry.reason;
      if (entry.detail !== undefined) record.detail = entry.detail;
      if (entry.counts !== undefined) record.counts = entry.counts;
      if (entry.versions !== undefined) record.versions = entry.versions;
      records.push(record);
      return record;
    },
    stages: () => records.slice(),
    toStageLatency() {
      const latency: Record<string, number> = {};
      for (const record of records) latency[record.name] = record.latency_ms;
      return latency;
    },
    setReviewContent(content) {
      review = { ...review, ...content };
    },
    reviewContent: () => (review ? { ...review } : null),
    markRequestStart(at) {
      if (requestStart !== null) return;
      const value = at ?? deps.now();
      if (Number.isFinite(value)) requestStart = value;
    },
    markGenerationStart() {
      if (requestStart === null || preGenerationMs !== null) return;
      preGenerationMs = elapsedSince(requestStart);
    },
    markFirstTextDelta() {
      if (requestStart === null || ttftMs !== null) return;
      ttftMs = elapsedSince(requestStart);
    },
    setCacheState(state) {
      if (CACHE_STATES.has(state)) cacheState = state;
    },
    timing() {
      if (requestStart === null) return null;
      return {
        ...(preGenerationMs !== null ? { pre_generation_ms: preGenerationMs } : {}),
        ...(ttftMs !== null ? { ttft_ms: ttftMs } : {}),
        cache: cacheState,
      };
    },
    toStageStatus() {
      const status: Record<string, StageRunStatus> = {};
      for (const record of records) status[record.name] = record.status;
      return status;
    },
  };
}
