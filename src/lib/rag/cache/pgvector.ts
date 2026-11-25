import type { RpcClient } from '../backend/supabase-rpc';
import type { SemanticCacheConfig } from '../config';
import type { SemanticCache } from './types';

export interface PgvectorSemanticCacheOptions {
  adminClient: () => RpcClient | null;
  config: Pick<SemanticCacheConfig, 'ttl' | 'refusalTtl' | 'maxDistance'>;
}

export function createPgvectorSemanticCache(_options: PgvectorSemanticCacheOptions): SemanticCache {
  return {
    check: async () => null,
    store: async () => undefined,
    invalidateTenant: async () => 0,
  };
}
