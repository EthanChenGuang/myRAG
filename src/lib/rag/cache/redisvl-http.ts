import type { RpcClient } from '../backend/supabase-rpc';
import type { SemanticCacheConfig } from '../config';
import type { SemanticCache } from './types';

export interface RedisvlSemanticCacheOptions {
  url: string;
  secret: string;
  fetch: typeof fetch;
  adminClient: () => RpcClient | null;
  config: Pick<SemanticCacheConfig, 'ttl' | 'maxDistance'>;
}

export function createRedisvlSemanticCache(_options: RedisvlSemanticCacheOptions): SemanticCache {
  return { check: async () => null, store: async () => undefined, invalidateTenant: async () => 0 };
}
