import type { StageName, StageTimeouts } from './config';
import type { TemporalQueryContext } from './query/temporal-query-detector';
import type { TenantScope } from './tenant/scope';
import type { TraceCollector } from './trace/collector';

export type Profile = 'chat' | 'embed' | 'voice' | 'media' | 'eval';

export type RetrievalStatus = 'ok' | 'empty' | 'error' | 'degraded';

export interface Candidate {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata: any;
  temporal_score: number;
  financial_score: number;
  final_score: number;
  match_reason: string;
}

export type StageRunStatus = 'ok' | 'skipped' | 'disabled' | 'error' | 'timeout' | 'aborted';

export type StageFailureReason = 'failed' | 'timeout' | 'aborted';

export interface StageRecord {
  name: string;
  status: StageRunStatus;
  reason?: StageFailureReason | 'disabled';
  startedAt: number;
  endedAt: number;
  latency_ms: number;
  candidates_in: number | null;
  candidates_out: number | null;
  rules: string[];
  detail?: string;
}

export interface RetrievalOptions {
  maxResults?: number;
  fallbackToLowerThreshold?: boolean;
}

export interface StageOverrides {
  disabledStages?: StageName[];
  timeouts?: StageTimeouts;
}

export interface RunRetrievalInput {
  scope: TenantScope | null;
  query: string;
  profile: Profile;
  documentRefs?: string[];
  options?: RetrievalOptions;
  signal: AbortSignal;
  trace?: TraceCollector;
  stageOverrides?: StageOverrides;
}

export interface RetrievalResult {
  status: RetrievalStatus;
  reason: string;
  candidates: Candidate[];
  context: string;
  usedDocuments: unknown[];
  sourceImages: unknown[];
  links: unknown[];
  stages: StageRecord[];
  traceId: string;
  queryContext: TemporalQueryContext | null;
}
