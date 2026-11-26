import type { ExtractedURL } from '@/lib/url-extractor';
import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { QueryParamsOverrides } from './query/query-params';
import type { RetrievalFilterInput } from './backend/types';
import type { VoiceResults } from './context/voice';
import type { QueryFramework, QueryTransformSwitches, SemanticCacheBackend, StageName, StageTimeouts } from './config';
import type { TemporalQueryContext } from './query/temporal-query-detector';
import type { RefusalRecord } from './refusal/types';
import type { DocType } from './ingest/profiles/load';
import type { InjectionCheckMode } from './security/config';
import type { RerankProviderId } from './rerank/types';
import type { TenantScope } from './tenant/scope';
import type { TraceCollector } from './trace/collector';
import type { CacheHit, CacheTicket } from './cache/types';

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
  /** Query layer only: the dense similarity under the standalone variant's list (0 when that list missed the chunk). */
  standaloneSimilarity?: number;
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
  versions?: string[];
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
  /** D-13: set only when the effective version scope is not current; effective dates are the document's own, else null. */
  version?: number;
  isCurrent?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  /** D-21: other documents holding the same passage as a kept chunk of this document; set only when there are any. */
  alsoIn?: AlsoIn[];
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
  /** D-48: the chunk's near-duplicate cluster, when the search returned one. */
  dupClusterId?: string;
  /** D-21: other documents of the cluster that the diversify stage dropped, in rank order. */
  alsoIn?: AlsoIn[];
}

/** Another document of a kept chunk's duplicate cluster (D-21): the first dropped chunk of that document. */
export interface AlsoIn {
  documentId: string;
  filename: string;
  chunkId: string;
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
  /** Eval profile only: doc type to binding profile id; replaces the effective bindings for this request (D-22). */
  embeddingBindings?: Partial<Record<DocType, string>>;
  /** Eval profile only: adds a global-profile leg filtered to this doc type (the comparison's control arm, D-22). */
  domainControlLeg?: DocType;
}

export type QueryVariantKind = 'original' | 'condensed' | 'expanded' | 'hyde' | 'sub_question' | 'translated' | 'terminology';

export interface QueryVariant {
  text: string;
  language: string | null;
  kind: QueryVariantKind;
  /** Retrieval legs this variant searches: 'dense' sends no lexical tokens (HyDE); absent means both (Phase 4 behaviour). */
  legs?: 'both' | 'dense';
  /** sub_question variants only: the index into QueryPlan.sub_questions. */
  subQuestionIndex?: number;
  /** The text embedded for the dense leg when it differs from text; absent means text. */
  denseText?: string;
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

export type { QueryParamsOverrides } from './query/query-params';

/** D-38 eval-only query-layer overrides; ignored for every other profile. They can only narrow what the environment enables. */
export interface QueryLayerOverrides {
  enabled?: boolean;
  framework?: QueryFramework;
  transforms?: Partial<QueryTransformSwitches>;
  semanticCache?: SemanticCacheBackend;
  queryParams?: QueryParamsOverrides;
}

export interface StageOverrides {
  disabledStages?: StageName[];
  timeouts?: StageTimeouts;
  retrievalOverrides?: RetrievalOverrides;
  queryLayer?: QueryLayerOverrides;
}

/** One earlier conversation turn, as sent in the request body (D-16). */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What the semantic cache needs from the entry point (D-32, spec rule 1). The entry profile is never caller data: it follows profile. */
export interface RetrievalCacheContext {
  generatorModel: string;
  /** hashSystemPromptTemplate of the system prompt template before {{context}} substitution. */
  systemPromptHash: string;
  webSearch: boolean;
  mcpTools: boolean;
  chatId: string | null;
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
  /** Earlier turns of the conversation, oldest first; read only by the query layer (D-16). */
  history?: HistoryTurn[];
  /** The entry point's classifyQuery result; the pipeline never classifies again (D-09). */
  classification?: QueryClassification;
  /** The client's IANA time zone for relative dates (D-11); validated where it is used. */
  timeZone?: string;
  /** Who asked and through which channel; read only by the retrieval log when this call owns its trace. */
  logContext?: LogContext;
  /** Chat and embed only; without it the semantic_cache stage stands down. */
  cacheContext?: RetrievalCacheContext;
  /** D-58: set server-side by the embed route only, never from a request body; a version scope then also needs RAG_EMBED_VERSION_SCOPE. */
  channel?: 'embed';
}

export type LogOutcomeValue = 'answered' | 'refused_no_context' | 'kb_unavailable' | 'degraded_answer' | 'unknown';

/** Set by every pipeline exit with value unknown; routes update it in place, and copies made with object spread share it. */
export interface LogOutcome {
  value: LogOutcomeValue;
  /** A language code of the final answer, never its text (D-03a). */
  answerLanguage: string | null;
  /** The pipeline that produced the result, set by runRetrieval. */
  pipeline?: 'legacy' | 'v2';
}

export type LogChannel = 'chat' | 'embed' | 'voice';

/** The request facts the retrieval log needs; no row is written without a channel. */
export interface LogContext {
  userId?: string | null;
  organizationId?: string | null;
  chatId?: string | null;
  channel?: LogChannel;
  ragMode?: RagMode | null;
  /** True for requests that must never be logged. */
  skip?: boolean;
}

/** What the injection_check stage found and did for one request (ids and rule ids only, never text). */
/** One checked item (a chunk or a referenced section): ids, document and rule ids only, never text. */
export interface InjectionItemRecord {
  kind: 'chunk' | 'reference';
  chunkIds: string[];
  documentId: string;
  /** The document's filename when the graph had the scoped document rows loaded. */
  documentName?: string;
  flagged: boolean;
  /** Detectors that flagged the item; empty when it was not flagged. */
  detectors: string[];
  ruleIds: string[];
}

export interface InjectionSummary {
  mode: Exclude<InjectionCheckMode, 'off'>;
  checkedCount: number;
  /** Flagged retrieved chunks and the chunks of flagged referenced sections. */
  flaggedChunkIds: string[];
  /** Documents whose referenced section was flagged. */
  flaggedReferenceIds: string[];
  droppedChunkIds: string[];
  droppedReferenceIds: string[];
  downweightedChunkIds: string[];
  ruleIds: string[];
  detectorsUnavailable: string[];
  /** Set only when an ML detector was configured but refused or unusable for this request, with the reason. */
  detectorsDisabled?: Record<string, string>;
  /** Set only when a needed ML detector failed: the first failure reason per detector (e.g. timeout, http_429). */
  detectorFailures?: Record<string, string>;
  flagged: boolean;
  /** Every checked item in check order; the eval trace's injection record is built from it. */
  items?: InjectionItemRecord[];
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
  /** Absent when RAG_INJECTION_CHECK is off or the stage did not run. */
  injection?: InjectionSummary;
  /** The D-03 query plan; absent unless the query layer ran. */
  queryPlan?: QueryPlan;
  /** Mutable holder the route sets before it returns (D-07); read by the after-response retrieval log write. */
  logOutcome?: LogOutcome;
  /** Set only on the semantic-cache short-circuit (status ok, reason cache_hit). */
  cacheHit?: CacheHit;
  /** Set when the semantic_cache stage checked with no check-time bypass; the entry point stores the answer with it. */
  cacheTicket?: CacheTicket;
}
