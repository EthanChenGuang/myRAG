import type { RagConfig } from '../config';
import type { Profile, RetrievalBackendSelection, RetrievalOverrides } from '../types';
import { getRetrievalBackend } from './registry';
import type { RpcClient } from './supabase-rpc';
import type { BackendId, RetrievalBackend } from './types';

export const EXTERNAL_SEARCH_TIMEOUT_MS = 1;


export interface ResolvedRetrievalBackend {
  backend: RetrievalBackend;
  choice: BackendId;
  selection(): RetrievalBackendSelection;
}

export interface ResolveBackendOptions {
  readinessRpc?: RpcClient | null;
  searchBudgetMs?: number | null;
}

export function resolveRetrievalBackend(
  _profile: Profile,
  _config: RagConfig,
  _overrides?: RetrievalOverrides,
  _options: ResolveBackendOptions = {},
): ResolvedRetrievalBackend {
  const backend = getRetrievalBackend();
  return { backend, choice: 'pgvector', selection: () => ({ backend: 'pgvector', fallbackReason: null, tenantValidationDropped: 0, degraded: false }) };
}

export function setExternalBackendForTests(_id: 'weaviate' | 'qdrant', _backend: RetrievalBackend | (() => RetrievalBackend) | null): void {}

export function resetBackendFactoryForTests(): void {}
