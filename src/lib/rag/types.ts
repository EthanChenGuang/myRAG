import type { TemporalQueryContext } from './query/temporal-query-detector';
import type { TenantScope } from './tenant/scope';

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

export interface StageRecord {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  durationMs: number;
  detail?: string;
}

export interface RetrievalOptions {
  maxResults?: number;
  fallbackToLowerThreshold?: boolean;
}

export interface RunRetrievalInput {
  scope: TenantScope | null;
  query: string;
  profile: Profile;
  documentRefs?: string[];
  options?: RetrievalOptions;
  signal: AbortSignal;
  trace?: unknown;
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
