import type { RpcClient } from '../backend/supabase-rpc';
import type { SemanticCacheBackend, SemanticCacheConfig } from '../config';
import type { SemanticCache } from './types';

export const SEMANTIC_CACHE_TIMEOUT_MS = 0;

export interface SemanticCacheIo {
  adminClient: () => RpcClient | null;
  fetch: typeof fetch;
  sidecarUrl: string;
  sidecarSecret: string;
}

export function withFailOpen(backend: SemanticCache, _name: Exclude<SemanticCacheBackend, 'off'>): SemanticCache {
  return backend;
}

export function getSemanticCache(_config: SemanticCacheConfig, _io: SemanticCacheIo): SemanticCache | null {
  return null;
}
