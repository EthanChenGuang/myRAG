export { runRetrieval, runStage, deriveStatus, StageError } from './pipeline';
export type { StageSpec, StageOutcome } from './pipeline';
export { parseRetrievalFilters } from './query/filters';
export type { RetrievalFilterInput } from './backend/types';
export { LEXICAL_VERSION } from './lexical/chunk-text';
export { RERANK_TEXT_VERSION } from './rerank/types';
export { countTokens } from './ingest/text/tokens';
export { isV2Pipeline } from './v2/switch';
export { loadRagConfig, CORE_STAGES, OPTIONAL_STAGES, PROFILE_STAGE_DEFAULTS } from './config';
export type { RagConfig, StageName } from './config';
export { createTraceCollector } from './trace/collector';
export type { TraceCollector, StageEntry } from './trace/collector';
export { finishTrace } from './trace/finish';
export type { FinishTraceOptions } from './trace/finish';
export { isTenantScope, scopeKey } from './tenant/scope';
export { evalScope } from './tenant/eval';
export type { EvalScopeInput, EvalScopeOutcome } from './tenant/eval';
export type { TenantScope } from './tenant/scope';
export { RetrievalBackendError } from './backend/supabase-rpc';
export { getRetrievalBackend, resetRetrievalBackendForTests, setRetrievalBackendForTests } from './backend/registry';
export { createPgvectorBackend } from './backend/pgvector';
export { getV2StartupVerdict, resetV2StartupForTests, verifyV2Startup } from './v2/startup';
export type { V2StartupVerdict, V2StartupStatus } from './v2/startup';
export { embedText, embedBatch } from './embeddings/openai';
export {
  getActiveProfile,
  refreshActiveProfile,
  getBackfillingProfiles,
  getStartupVerdict,
  verifyActiveEmbeddingProfileAtStartup,
  isEmbeddingProfilesEnabled,
  LEGACY_PROFILE,
  ProfileUnavailableError,
} from './embeddings/active-profile';
export type {
  EmbeddingProfile,
  EmbeddingProfileState,
  ProfileUnavailableReason,
  StartupMismatchReason,
  StartupVerdict,
} from './embeddings/active-profile';
export {
  getEmbeddingProfileStatus,
  activateEmbeddingProfile,
  rollbackEmbeddingProfile,
  setEmbeddingProfileStatus,
} from './embeddings/profile-ops';
export type {
  ActivateResult,
  EmbeddingProfileStatus,
  ProfileRefusal,
  RollbackResult,
  SetStatusResult,
} from './embeddings/profile-ops';
export {
  listChunkingProfiles,
  getChunkingCoverage,
  getChunkingProfileState,
  createChunkingProfile,
  recordChunkingDecision,
  activateChunkingProfile,
  rollbackChunkingProfile,
  ChunkingActivationRefused,
  ChunkingInputError,
} from './chunking/profile-ops';
export type {
  ChunkingCoverageRow,
  ChunkingProfileRecord,
  ChunkingProfileState,
  CreateChunkingProfileInput,
} from './chunking/profile-ops';
export { validateChunkingProfile } from './chunking/validate';
export type { ChunkingFinding, ChunkingValidationContext, ChunkingValidationResult } from './chunking/validate';
export { getChunkingSweepReport, getChunkingDecisions, ChunkingReportInvalid } from './chunking/report';
export type { ChunkingReportCode } from './chunking/report';
export { refusalCalibrationStatus, currentRefusalCalibrationStatus } from './refusal/status';
export type { RefusalCalibrationStatus } from './refusal/status';
export type {
  Candidate,
  Profile,
  RetrievalOptions,
  RetrievalResult,
  RetrievalStatus,
  RunRetrievalInput,
  StageFailureReason,
  StageOverrides,
  StageRecord,
  StageRunStatus,
} from './types';
export { resolveTenantScope } from './tenant/resolve-chat';
export type { ResolveTenantScopeInput, TenantResolveFailure, TenantResolveResult } from './tenant/resolve-chat';
export { isOrganizationMember } from './tenant/membership';
export { resolveAdminWorkspaceScope, nangoOwnerScope } from './tenant/ingest-scope';
export type {
  IngestScopeResult,
  NangoOwnerScopeInput,
  ResolveAdminWorkspaceScopeInput,
} from './tenant/ingest-scope';
export { resolveEmbedScope, parseTenantKey } from './tenant/embed';
export type { EmbedScopeFailure, EmbedScopeResult, ResolveEmbedScopeInput, TenantKey } from './tenant/embed';
export { mintVoiceToken, verifyVoiceToken, defaultVoiceTtlSeconds, VOICE_TOKEN_AUDIENCE } from './tenant/voice-token';
export type { MintVoiceTokenInput, MintVoiceTokenResult, VerifyVoiceTokenResult, VoiceTokenPayload } from './tenant/voice-token';
export { resolveVoiceScope, VOICE_SCOPE_HEADER } from './tenant/voice';
export type { ResolveVoiceScopeInput, VoiceScopeResult } from './tenant/voice';
export { assembleContext } from './context/assemble';
export type { AssembleInput, AssembleOutput, AssemblyCandidate, AssemblyDocumentRow } from './context/assemble';
export { fetchAssemblyRows } from './context/fetch-rows';
export type { AssemblyRows } from './context/fetch-rows';
export type {
  CitationLabel,
  CitationLabeler,
  ContextBlock,
  KeptBy,
  KeptChunk,
  RagMode,
  ReferencedSection,
  ReferencedState,
  SourceImage,
  UsedDocument,
} from './types';
export type { VoiceResult, VoiceResults, VoiceSourceImage } from './context/voice';
export { deriveVoiceKeywords } from './voice/keyword-fallback';
export { createEnhancedRAGPrompt } from './generation/prompt';
export { knowledgeBaseUnavailableMessage } from './generation/messages';
export { readGenerationConfig } from './generation/config';
export type { GenerationConfig } from './generation/config';
export { createCitationSession } from './generation/citations/session';
export type {
  CitationCapabilities,
  CitationFinishMetadata,
  CitationSession,
  CitationSessionInput,
} from './generation/citations/session';
export { selectCitationStrategy } from './generation/citations/strategy';
export type { CitationRagMode, CitationStrategyId, CitationTurn } from './generation/citations/strategy';
export { repairOwnerMembership } from './tenant/repair-owner';
export type { RepairOwnerMembershipInput } from './tenant/repair-owner';
export { resolveDocumentRefs } from './refs/resolve';
export type { ResolveDocumentRefsInput, ResolvedDocumentRefs } from './refs/resolve';
export type { DocumentPartRef, DocumentRefsInput } from './types';
export { assembleOverviewContext, OVERVIEW_QUERY } from './context/overview';
export type { OverviewChunk, OverviewContext } from './context/overview';
export { requireRagAdmin, isAdminUser } from './tenant/admin';
export type { RagAdminDb, RagAdminResult, RequireRagAdminInput } from './tenant/admin';
export {
  ingest,
  resumeIngest,
  getIngestStatus,
  currentIngestConfig,
  buildSourceKey,
} from './ingest';
export type { IngestConfig } from './ingest/config';
export type {
  IngestInput,
  IngestOptions,
  IngestOrigin,
  IngestResult,
  IngestSource,
  IngestStatus,
  IngestStatusView,
  ResumeIngestOptions,
} from './ingest';
export { loadIngestConfig } from './ingest/config';
export { assertCloudAllowed, CloudRefused } from './ingest/guard/cloud-budget';
export { findInvoices } from './retrieval/invoices';
export type { FindInvoicesDeps, InvoiceFilters, InvoiceHit } from './retrieval/invoices';
export { runChunkingBuildStep } from './ingest/rechunk/build-step';
export type { ChunkingBuildStepOptions } from './ingest/rechunk/build-step';
export { RechunkInputError, RechunkDatabaseError } from './ingest/rechunk/run';
export type { RechunkReport } from './ingest/rechunk/run';
export { getIngestStatusReport, STALE_PROCESSING_MS } from './ingest/status';
export type { IngestStatusReport } from './ingest/status';
export { IngestLedgerError, deleteJob, getJobForScope, listJobs, listJobsPage, retryJob } from './ingest/ledger';
export { runIngestionMaintenance } from './ingest/maintenance';
export type { JobsPage, ListJobsArgs } from './ingest/ledger';
export { PARSE_TIERS, ParseAdminError, listTierBounds, readBudgetView, setTierOverride } from './ingest/parse-admin';
export type { BudgetTenantUsage, BudgetView, ParseTierName, SetTierOverrideInput, TierBoundsItem, TierBoundsPair, TierOverrideView } from './ingest/parse-admin';
export { listQuarantine } from './ingest/quarantine-admin';
export { releaseQuarantined } from './ingest/quarantine-admin';
export { deleteQuarantined } from './ingest/quarantine-admin';
export type {
  DeleteQuarantinedResult,
  ListQuarantineInput,
  ListQuarantineResult,
  QuarantineActionInput,
  QuarantineFailure,
  QuarantineItem,
  ReleaseQuarantinedResult,
} from './ingest/quarantine-admin';
export { docTypePickerEnabled, resolvePickerDefault, listDocTypeDefaults, setDocTypeDefault, DocTypeDefaultsError, DOC_TYPE_DEFAULT_SOURCE_KINDS, DOC_TYPE_IDS, DOC_TYPE_CHOICES } from './ingest/profiles/doc-type-defaults';
export type { DocTypeChoice, DocTypeDefaultRow, DocTypeDefaultSourceKind, PickerDefault, SetDocTypeDefaultInput } from './ingest/profiles/doc-type-defaults';
export { getEmbeddingProfileCompleteness } from './embeddings/profile-ops';
export type { ProfileCompleteness } from './embeddings/profile-ops';
export { INGEST_SOURCES } from './ingest/types';
export { changeDocumentType } from './ingest/change-doc-type';
export { enqueueIngest, submitIngest } from './ingest/enqueue';
export type { EnqueueIngestOptions, EnqueueResult } from './ingest/enqueue';
export { scheduleIngestWake } from './ingest/wake';
export { loadQueueConfig, queueConfigFromProcessEnv } from './ingest/queue-config';
export type { QueueConfig } from './ingest/queue-config';
export { handleAdvance } from './ingest/callbacks/advance';
export { handleParseExternal } from './ingest/callbacks/parse-external';
export { handleDetectVlm } from './ingest/callbacks/detect-vlm';
export { checkSidecarSecret, SIDECAR_SECRET_HEADER } from './ingest/callbacks/internal-auth';
export type { ChangeDocumentTypeFailure, ChangeDocumentTypeInput, ChangeDocumentTypeResult } from './ingest/change-doc-type';
export { scopeForAdminDocument, AdminDocumentScopeError } from './tenant/ingest-scope';
export type { AdminDocumentScopeInput } from './tenant/ingest-scope';
export { softDeleteLineage } from './ingest/soft-delete';
export { removeDocumentObjects } from './ingest/remove-document-objects';
export type { DocumentObjectRow } from './ingest/remove-document-objects';
export type { SoftDeleteResult, SoftDeleteFailure } from './ingest/soft-delete';
