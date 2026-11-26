export { runRetrieval, runStage, deriveStatus, StageError } from './pipeline';
export type { StageSpec, StageOutcome } from './pipeline';
export { parseRetrievalFilters } from './query/filters';
export { resolveScopesFilter, ScopeFilterError } from './query/scopes';
export type { RetrievalFilterInput } from './backend/types';
export { LEXICAL_VERSION } from './lexical/chunk-text';
export { RERANK_TEXT_VERSION } from './rerank/types';
export { countTokens } from './ingest/text/tokens';
export { isQueryLayerEnabled, isSemanticCacheActive, isV2Pipeline, voiceServerCondenses } from './v2/switch';
export { isSmallTalkResult } from './v2/result';
export { buildHistoryWindow } from './query/history';
export type { HistoryWindowLimits } from './query/history';
export { loadRagConfig, effectiveLexicalVersion, CORE_STAGES, OPTIONAL_STAGES, PROFILE_STAGE_DEFAULTS } from './config';
export type { RagConfig, StageName } from './config';
export { createTraceCollector } from './trace/collector';
export type { TraceCollector, StageEntry } from './trace/collector';
export { isTraceId } from './trace/collector';
export type { TraceCacheState, TraceTiming } from './trace/collector';
export { withFirstTextDelta, awaitPreGenerationDelay, setPreGenerationDelayForTests, resetPreGenerationDelayForTests } from './trace/ttft';
export { postLangfuseScores } from './trace/scores';
export type { LangfuseScoreInput, PostScoresResult } from './trace/scores';
export { finishTrace } from './trace/finish';
export type { FinishTraceOptions } from './trace/finish';
export { isTenantScope, scopeKey } from './tenant/scope';
export { evalScope } from './tenant/eval';
export type { EvalScopeInput, EvalScopeOutcome } from './tenant/eval';
export type { TenantScope } from './tenant/scope';
export { getTerminologyLexicon, TerminologyUnavailableError } from './terminology/lexicon';
export type { TerminologyLexicon, TerminologyLexiconOptions } from './terminology/lexicon';
export { RetrievalBackendError } from './backend/supabase-rpc';
export { getRetrievalBackend, resetRetrievalBackendForTests, setRetrievalBackendForTests } from './backend/registry';
export { createPgvectorBackend } from './backend/pgvector';
export { getV2StartupVerdict, resetV2StartupForTests, verifyV2Startup } from './v2/startup';
export { verifyLanguageSettingsAtStartup } from './lang/startup';
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
  HistoryTurn,
  LogChannel,
  LogContext,
  LogOutcome,
  LogOutcomeValue,
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
export { submitAnswerFeedback } from './generation/feedback';
export { listReviewCandidates } from './trace/review-candidates';
export type { ListReviewCandidatesResult } from './trace/review-candidates';
export type { SubmitAnswerFeedbackDeps, SubmitAnswerFeedbackInput, SubmitAnswerFeedbackResult } from './generation/feedback';
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
export {
  answerLanguageInstruction,
  answerLanguageOptions,
  appendAnswerLanguage,
  contextLanguages,
  type AnswerLanguageOptions,
} from './generation/answer-language';
export {
  knowledgeBaseUnavailableLanguage,
  knowledgeBaseUnavailableMessage,
  noKnowledgeBaseResponse,
  noKnowledgeBaseResponseLanguage,
} from './generation/messages';
export { readFeedbackLoopConfig } from './feedback-loop/config';
export { EMBED_FEEDBACK_AUDIENCE, mintEmbedFeedbackToken, verifyEmbedFeedbackToken } from './feedback-loop/embed-token';
export type { EmbedFeedbackTokenClaims } from './feedback-loop/embed-token';
export { readGenerationConfig } from './generation/config';
export { detectLanguage } from './lang/detect';
export type { Language } from './lang/registry';
export type { GenerationConfig } from './generation/config';
export { createCitationSession } from './generation/citations/session';
export type {
  CitationCapabilities,
  CitationFinishMetadata,
  CitationSession,
  CitationSessionInput,
  ClaudeStartInput,
  HistoryMessage,
} from './generation/citations/session';
export { mintAnswerId, scheduleAnswerFinish, shouldPersistAnswer } from './generation/answer-finish';
export type { AnswerFinishDeps, AnswerFinishInput, AnswerPendingContext, ShouldPersistAnswerInput } from './generation/answer-finish';
export { groundednessEligibility, scoreAnswerGroundedness } from './generation/groundedness';
export type {
  AnswerGroundedness,
  GroundednessEligibility,
  GroundednessEligibilityInput,
  ScoreAnswerGroundednessDeps,
  ScoreAnswerGroundednessInput,
} from './generation/groundedness';
export { claudeTurnEligibility, preRetrievalCitations, selectCitationStrategy } from './generation/citations/strategy';
export { CLAUDE_FIRST_TOKEN_TIMEOUT_MS, errorStatusOf, fallbackReasonFor, firstTokenGate } from './generation/citations/fallback';
export type { FallbackReason, FirstTokenGateResult } from './generation/citations/fallback';
export type {
  CitationRagMode,
  CitationStrategyId,
  CitationTurn,
  ClaudeIneligibleReason,
  ClaudeTurnEligibility,
  ClaudeTurnFacts,
} from './generation/citations/strategy';
export { repairOwnerMembership } from './tenant/repair-owner';
export type { RepairOwnerMembershipInput } from './tenant/repair-owner';
export { resolveDocumentRefs } from './refs/resolve';
export type { ResolveDocumentRefsInput, ResolvedDocumentRefs } from './refs/resolve';
export type { DocumentPartRef, DocumentRefsInput } from './types';
export { assembleOverviewContext, OVERVIEW_QUERY } from './context/overview';
export type { OverviewChunk, OverviewContext } from './context/overview';
export { requireRagAdmin, isAdminUser, verifyRagUser } from './tenant/admin';
export type { RagAdminDb, RagAdminResult, RequireRagAdminInput } from './tenant/admin';
export {
  ingest,
  resumeIngest,
  getIngestStatus,
  currentIngestConfig,
  unifiedIngestRefusal,
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
export {
  UPLOAD_APPROVAL_REQUIRES_UNIFIED,
  UploadApprovalRequiresUnifiedError,
  approvalRequiresUnified,
  assertLegacyWriteAllowed,
  legacyApprovalRefusal,
  legacyWriteRefused,
} from './ingest/approval/legacy-refusal';
export { assertCloudAllowed, CloudRefused } from './ingest/guard/cloud-budget';
export { legacyLlamaparseLanguages } from './ingest/routing/effective-settings';
export {
  LANGUAGE_AWARE_REQUIRES_UNIFIED,
  LanguageAwareIngestError,
  assertLegacySplitterAllowed,
  currentLegacyUploadRoute,
  legacyUploadRoute,
} from './ingest/routing/language-aware-routing';
export type { LegacyUploadRoute } from './ingest/routing/language-aware-routing';
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
export { deleteQuarantined, listNotChecked } from './ingest/quarantine-admin';
export type {
  DeleteQuarantinedResult,
  ListQuarantineInput,
  ListNotCheckedResult,
  ListQuarantineResult,
  NotCheckedItem,
  QuarantineActionInput,
  QuarantineFailure,
  QuarantineItem,
  ReleaseQuarantinedResult,
} from './ingest/quarantine-admin';
export {
  addExemption,
  approveUpload,
  exemptionChoices,
  listExemptions,
  listPendingUploads,
  rejectUpload,
  removeExemption,
} from './ingest/approval/admin';
export type {
  AddExemptionResult,
  ApprovalFailure,
  ApproveUploadResult,
  ExemptionChoice,
  PendingUpload,
  RejectUploadResult,
  UploadExemption,
  UserDisplay,
} from './ingest/approval/admin';
export {
  createVocabularyEntry,
  DOCUMENT_VIEWS,
  listDocumentsWithScopes,
  listVocabulary,
  MAX_DOCUMENT_SCOPES,
  normalizeScopeValue,
  SCOPE_DIMENSIONS,
  scopeTagsEnabled,
  setDocumentScopes,
  updateVocabularyEntry,
} from './ingest/scopes/admin';
export type {
  DocumentView,
  ListDocumentsWithScopesResult,
  ListVocabularyResult,
  ScopeDimension,
  ScopeSuggestionItem,
  TaggedDocument,
  ScopeFailure,
  SetDocumentScopesResult,
  VocabularyEntry,
  VocabularyEntryResult,
} from './ingest/scopes/admin';
export { activeUploadVocabulary, uploadScopesEnabled, validateUploadScopes, warnUploadScopesIgnored } from './ingest/scopes/upload';
export type { UploadScopeFailure, UploadVocabularyEntry, ValidateUploadScopesResult } from './ingest/scopes/upload';
export {
  confirmSupersession,
  dismissSupersession,
  listSupersession,
  replacesConfirmedAtOnce,
  replacesEnabled,
  undoSupersession,
  validateUploadReplaces,
} from './ingest/versions/admin';
export type {
  SupersessionAdminFailure,
  SupersessionDocumentView,
  SupersessionEntry,
  UploadReplacesFailure,
  ValidateUploadReplacesResult,
} from './ingest/versions/admin';
export {
  AUTO_APPLY_MIN_CONFIDENCE,
  MAX_QUERY_LENGTH as MAX_EFFECTIVE_DATES_QUERY_LENGTH,
  applyEffectiveDates,
  decideEffectiveDateProposal,
  dismissEffectiveDateProposal,
  listEffectiveDateProposals,
  recordExtractedEffectiveDates,
  todayUtc as effectiveDatesTodayUtc,
} from './ingest/versions/effective-dates';
export type {
  ApplyEffectiveDatesResult,
  CurrentEffectiveDates,
  DismissEffectiveDateProposalResult,
  EffectiveDateDecision,
  EffectiveDateProposalInput,
  EffectiveDatesFailure,
  EffectiveDatesItem,
  ListEffectiveDateProposalsResult,
  RecordExtractedEffectiveDatesResult,
  StoredEffectiveDateProposal,
} from './ingest/versions/effective-dates';
export { getTranslationSettings, languageDocumentCounts, setTranslationSettings, translationCoverage, validateTranslationTargets, MAX_TRANSLATION_TARGETS } from './ingest/translate/settings';
export type {
  LanguageDocumentCount,
  SetTranslationSettingsInput,
  TranslationCoverageRow,
  TranslationSettingsError,
  TranslationSettingsFailure,
  TranslationSettingsView,
} from './ingest/translate/settings';
export { docTypePickerEnabled, resolvePickerDefault, listDocTypeDefaults, setDocTypeDefault, DocTypeDefaultsError, DOC_TYPE_DEFAULT_SOURCE_KINDS, DOC_TYPE_IDS, DOC_TYPE_CHOICES } from './ingest/profiles/doc-type-defaults';
export type { DocTypeChoice, DocTypeDefaultRow, DocTypeDefaultSourceKind, PickerDefault, SetDocTypeDefaultInput } from './ingest/profiles/doc-type-defaults';
export { getEmbeddingProfileCompleteness } from './embeddings/profile-ops';
export type { ProfileCompleteness } from './embeddings/profile-ops';
export {
  listBindings,
  createBinding,
  setBindingStatus,
  activateBinding,
  rollbackBinding,
  deactivateBinding,
  getBindingCompleteness,
} from './embeddings/binding-ops';
export type {
  ActivateBindingResult,
  BindingCompleteness,
  BindingListEntry,
  BindingRefusal,
  CreateBindingResult,
  DeactivateBindingResult,
  RollbackBindingResult,
  SetBindingStatusResult,
} from './embeddings/binding-ops';
export { isDomainEmbeddingsEnabled, listProfileScopes, BINDING_DOC_TYPES } from './embeddings/bindings';
export type { BindingStatus } from './embeddings/bindings';
export { listEmbeddingProfiles } from './embeddings/active-profile';
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
export { handleTranslateCallback } from './ingest/callbacks/translate';
export { checkSidecarSecret, SIDECAR_SECRET_HEADER } from './ingest/callbacks/internal-auth';
export type { ChangeDocumentTypeFailure, ChangeDocumentTypeInput, ChangeDocumentTypeResult } from './ingest/change-doc-type';
export { scopeForAdminDocument, AdminDocumentScopeError } from './tenant/ingest-scope';
export type { AdminDocumentScopeInput } from './tenant/ingest-scope';
export { softDeleteLineage } from './ingest/soft-delete';
export { removeDocumentObjects } from './ingest/remove-document-objects';
export type { DocumentObjectRow } from './ingest/remove-document-objects';
export type { SoftDeleteResult, SoftDeleteFailure } from './ingest/soft-delete';
export { escapeTags, REFERENCE_NOTICE, TOOL_RESULT_NOTICE, TOOL_RESULT_SENTENCE } from './context/wrap';
export { readSecurityConfig } from './security/config';
export { injectionTraceVersions } from './security/injection-check';
export type { ToolResultGuardMode } from './security/config';
export { escapeToolOutput, scanToolOutput, wrapToolResultsForPrompt } from './security/tool-results';
export { FingerprintImpactError, computeFingerprintCoverage, computeFingerprintImpact, isSettingName } from './ingest/fingerprint/impact';
export type { FingerprintCoverage, PendingRebuild, RebuildStart } from './ingest/fingerprint/impact';
export {
  RebuildInputError,
  RebuildNotFound,
  RebuildRefused,
  RebuildUnavailable,
  activateRebuild,
  getRebuildRun,
  listRebuildRuns,
  recordRebuildEvidence,
  rollbackRebuild,
  startRebuild,
} from './ingest/rebuild/run';
export type { RebuildActivation, RebuildRunRow, RebuildRunState, StartRebuildResult } from './ingest/rebuild/run';
export { MECHANISM_COMMANDS } from './ingest/fingerprint/impact';
export { REBUILDABLE_MECHANISMS, isRebuildableMechanism } from './ingest/rebuild/plan';
export {
  effectiveLogMode,
  readTenantFeedbackSettings,
  setTenantFeedbackSettings,
  TENANT_RETRIEVAL_LOG_LEVELS,
} from './feedback-loop/settings';
export type { TenantFeedbackSettingsRow, TenantRetrievalLog } from './feedback-loop/settings';
export { purgeRetrievalLog, PurgeError } from './feedback-loop/purge';
export type { PurgeCounts } from './feedback-loop/purge';
export { isMiningWindowError, miningDisabledReason, MiningError, parseMiningDate, runMining } from './feedback-loop/mining';
export { computeFeedbackLoopStats, isStatsWindowError, MAX_STATS_WINDOW_DAYS, StatsError } from './feedback-loop/stats';
export {
  getReviewItem,
  getReviewItemChunks,
  grantDomainExpert,
  isReviewItemId,
  listDomainExperts,
  listReviewItems,
  REVIEW_PAGE_SIZE,
  ReviewListQuerySchema,
  revokeDomainExpert,
  validateGrantTenantKey,
} from './feedback-loop/review-access';
export type { DomainExpertGrant, ReviewChunk, ReviewListQuery } from './feedback-loop/review-access';
export { openReviewSession, REVIEW_NO_STORE, reviewNotFound, reviewUnavailable } from './feedback-loop/review-route';
export { recordSourceOpened, setRefusalVote, SOURCE_OPENED_CAP } from './feedback-loop/votes';
export type { RecordSourceOpenedResult, SetRefusalVoteResult } from './feedback-loop/votes';
export {
  openRetrievalRequest,
  RETRIEVAL_NO_STORE,
  retrievalNotFound,
  retrievalUnavailable,
  traceHash,
} from './feedback-loop/retrieval-route';
export { LabelRequestSchema, normalizeQuoteText, validateAndSaveLabel } from './feedback-loop/labels';
export type { EvidenceFailureReason, LabelRequest, SaveLabelResult } from './feedback-loop/labels';
export { REVIEW_SEARCH_POOL, ReviewSearchRequestSchema, searchForReviewItem } from './feedback-loop/review-search';
export {
  buildExport,
  EXPORT_KINDS,
  exportDictionary,
  exportGolden,
  exportTraining,
  GoldenExportLineSchema,
  markExported,
  MarkExportedRequestSchema,
} from './feedback-loop/exports';
export type { ExportKind, GoldenExportLine, MarkExportedRequest, MarkItem, MarkResult } from './feedback-loop/exports';
export type { ReviewSearchHit, ReviewSearchRequest, ReviewSearchResult } from './feedback-loop/review-search';
export { hashSystemPromptTemplate } from './cache/keys';
export { cacheSourcesFromResult, scheduleCacheStore } from './cache/store-after';
export type { CacheStoreFacts, CacheStoreSource, ScheduleCacheStoreInput } from './cache/store-after';
export { cacheHitMetadata, streamCachedAnswer } from './cache/hit-stream';
export { clearTenantSemanticCache, SEMANTIC_CACHE_ADMIN_TIMEOUT_MS } from './cache/admin';
export type { ClearSemanticCacheError, ClearSemanticCacheOptions, ClearSemanticCacheResult } from './cache/admin';
export { isCacheHitResult } from './v2/result';
