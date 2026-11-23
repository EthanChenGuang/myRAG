import type { ExtractedURL } from '@/lib/url-extractor';
import type { VoiceResults } from './context/voice';
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

export interface UsedDocument {
  id: string;
  name: string;
  filename: string;
  created_at?: string;
  content_preview?: string;
  similarity?: number;
  matched_chunk?: string;
  explicitly_referenced?: boolean;
  image_url?: string;
  external_url?: string;
}

export interface SourceImage {
  name: string;
  size: number;
  type: string;
  url: string | undefined;
}

export type KeptBy = 'similarity' | 'name' | 'image';

export interface KeptChunk {
  chunk_id: string;
  document_id: string;
  document_name: string;
  content: string;
  similarity: number;
  rank: number;
  kept_by: KeptBy;
}

export type RagMode = 'strict' | 'balanced' | 'flexible' | 'bypass';

export interface ReferencedState {
  usedDocuments: UsedDocument[];
  context: string;
}

export interface DocumentPartRef {
  id: string;
  name: string;
}

export interface DocumentRefsInput {
  mentions: string[];
  documentParts: DocumentPartRef[];
}

export interface RetrievalOptions {
  maxResults?: number;
  fallbackToLowerThreshold?: boolean;
  isGPTModel?: boolean;
  ragMode?: RagMode;
  webSearchEnabled?: boolean;
  mediaKind?: 'image' | 'video';
  generalOverview?: boolean;
  degrade?: 'drop_top_candidate';
}

export interface StageOverrides {
  disabledStages?: StageName[];
  timeouts?: StageTimeouts;
}

export interface RunRetrievalInput {
  scope: TenantScope | null;
  query: string;
  profile: Profile;
  documentRefs?: DocumentRefsInput;
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
  usedDocuments: UsedDocument[];
  sourceImages: SourceImage[];
  links: ExtractedURL[];
  relevantChunks: Candidate[];
  kept: KeptChunk[];
  queryTerms: string[];
  refusalCandidate: boolean;
  stages: StageRecord[];
  traceId: string;
  queryContext: TemporalQueryContext | null;
  voice?: VoiceResults;
}
