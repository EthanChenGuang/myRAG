export { runRetrieval } from './pipeline';
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
  StageRecord,
} from './types';
