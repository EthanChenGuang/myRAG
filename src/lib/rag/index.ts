export { runRetrieval, runStage, deriveStatus, StageError } from './pipeline';
export type { StageSpec, StageOutcome } from './pipeline';
export { loadRagConfig, CORE_STAGES, OPTIONAL_STAGES, PROFILE_STAGE_DEFAULTS } from './config';
export type { RagConfig, StageName } from './config';
export { isTenantScope } from './tenant/scope';
export { evalScope } from './tenant/eval';
export type { EvalScopeInput, EvalScopeOutcome } from './tenant/eval';
export type { TenantScope } from './tenant/scope';
export { RetrievalBackendError } from './backend/supabase-rpc';
export { embedText, embedBatch } from './embeddings/openai';
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
