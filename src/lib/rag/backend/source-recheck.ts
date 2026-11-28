import type { BackendId } from './types';

export type ExternalBackendId = Extract<BackendId, 'weaviate' | 'qdrant'>;

export function isExternalBackendId(id: unknown): id is ExternalBackendId {
  return id === 'weaviate' || id === 'qdrant';
}

export interface SourceRecheckDecision {
  /** Whether the candidates of this request are rechecked against Supabase. */
  run: boolean;
  /** True when no setting can turn the recheck off: the backend's own re-validation is the recheck (D-10, RET-05). */
  forced: boolean;
}

/**
 * RET-05, RET-14: on Weaviate and Qdrant the recheck always runs, whatever RAG_SOURCE_RECHECK says; a request served by pgvector
 * (the default, or a fallback in the same request) follows the configured switch.
 */
export function sourceRecheckDecision(backendUsed: BackendId, configured: boolean): SourceRecheckDecision {
  if (isExternalBackendId(backendUsed)) return { run: true, forced: true };
  return { run: configured === true, forced: false };
}
