import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { storeScopeForTenantKey } from '../tenant/store-scope';
import { scheduleAfterResponse } from '../trace/schedule';
import type { TenantScope } from '../tenant/scope';
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

/**
 * After an in-place document write that the SQL function already invalidated for pgvector (scope tags, effective dates, upload
 * approval, attribute import), schedules the same invalidation on the RedisVL backend after the response. The tenant key is the one the
 * writer's guard admitted and its RPC accepted, never request data. No-op without RedisVL or without a document id; never throws.
 */
export function scheduleRedisvlInvalidation(tenantKey: string, documentIds: ReadonlyArray<string | null | undefined>): void {
  const cache = redisvlInvalidationTarget();
  if (!cache) return;
  const ids = [...new Set(documentIds.filter((id): id is string => typeof id === 'string' && id.length > 0).map((id) => id.toLowerCase()))];
  if (ids.length === 0) return;
  let scope: TenantScope;
  try {
    scope = storeScopeForTenantKey(tenantKey);
  } catch {
    return;
  }
  scheduleAfterResponse(async () => {
    await cache.invalidateTenant(scope, ids);
  });
}
