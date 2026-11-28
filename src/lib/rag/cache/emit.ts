import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import type { SemanticCache } from './types';

/**
 * The cache an app-side document change must invalidate: the RedisVL backend only. With pgvector the database triggers on documents
 * invalidate in the same transaction, and with the cache off there is nothing to do; both give null (D-35).
 */
export function redisvlInvalidationTarget(): SemanticCache | null {
  try {
    const deps = getRagDeps();
    if (loadRagConfig(deps.ragEnv()).semanticCache.backend !== 'redisvl') return null;
    return deps.semanticCache();
  } catch {
    return null;
  }
}
