import type { ExtractedURL } from '@/lib/url-extractor';
import type { RetrievalFilterInput } from './backend/types';
import type { VoiceResults } from './context/voice';
import type { StageName, StageTimeouts } from './config';
import type { TemporalQueryContext } from './query/temporal-query-detector';
import type { RefusalRecord } from './refusal/types';
import type { RerankProviderId } from './rerank/types';
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
  rerank_score?: number;
  fused_score?: number;
  parent_id?: string | null;
  legs?: Record<string, number>;
  language?: string | null;
}

export type StageRunStatus = 'ok' | 'skipped' | 'disabled' | 'degraded' | 'error' | 'timeout' | 'aborted';

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
  counts?: Record<string, number>;
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

export type KeptBy = 'similarity' | 'name' | 'image' | 'rerank' | 'fused';

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

export interface ReferencedSection {
  documentId: string;
  documentName: string;
  /** Chunks whose content was used; empty when the document's full text was used. */
  chunkIds: string[];
  text: string;
  /** True when the document was referenced but no content could be read; rendered as a note, never a block. */
  missing?: boolean;
}

export interface ReferencedState {
  usedDocuments: UsedDocument[];
  context: string;
  /** The referenced part of the context as data, in render order. */
  sections?: ReferencedSection[];
}

/** One citable unit of the final context, in the order it appears in the rendered context (Phase 5 D-02). */
export interface ContextBlock {
  documentId: string;
  documentName: string;
  documentVersion: number | null;
  chunkIds: string[];
  page: number | null;
  sectionPath: string[] | null;
  title: string;
  /** Exactly the text written to the context for this block. */
  text: string;
  isImage: boolean;
  alias: string | null;
}

export interface CitationLabel {
  alias: string;
  /** One line written before the block. */
  header: string;
  /** Written in place of the block text. */
  text: string;
}

/** Called once per non-image block in render order, ordinals from 1. */
export type CitationLabeler = (block: Omit<ContextBlock, 'alias'>, ordinal: number) => CitationLabel;

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
  /** Eval profile only: embed and search a specific embedding profile (non-active allowed). */
  embeddingProfile?: string;
}

export interface QueryVariant {
  text: string;
  language: string | null;
  kind: 'original' | 'translated';
}

export interface RetrievalOverrides {
  candidatePoolSize?: number;
  rerankInputCap?: number;
  finalTopK?: number;
  rrfK?: number;
  legWeights?: { dense?: number; lexical?: number; exactId?: number };
  reranker?: RerankProviderId | 'none';
  rerankModel?: string;
  rerankTier?: 'fast' | 'quality';
  switches?: {
    lexicalSearch?: boolean;
    refusalThreshold?: boolean;
    edgeOrder?: boolean;
    compression?: boolean;
    parentChild?: boolean;
    lexicalTranslation?: boolean;
  };
  iterativeScan?: string;
  exactScanCutoff?: number;
  chunkingProfileByDocType?: Record<string, string>;
}

export interface StageOverrides {
  disabledStages?: StageName[];
  timeouts?: StageTimeouts;
  retrievalOverrides?: RetrievalOverrides;
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
  retrievalFilters?: RetrievalFilterInput;
  queryVariants?: QueryVariant[];
  /** When absent the context is rendered exactly as without citations. */
  citationLabeler?: CitationLabeler;
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
  refusal?: RefusalRecord | null;
  retrievalConfigHash?: string;
  queryLanguage?: string | null;
  /** The final context blocks in render order; absent when no assembly ran. */
  blocks?: ContextBlock[];
}
