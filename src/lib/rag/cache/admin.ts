import { getDeploymentMode, type DeploymentMode } from '@/lib/deployment-mode';
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { backfillScope } from '../tenant/backfill-scope';
import { parseTenantKey } from '../tenant/embed';
import { hashedTenantKey } from './index';

export type ClearSemanticCacheError = 'invalid_tenant_key' | 'unknown_tenant' | 'semantic_cache_unavailable';

export type ClearSemanticCacheResult =
  | { ok: true; deleted: number; backend: 'off' | 'pgvector' | 'redisvl' }
  | { ok: false; status: 400 | 503; error: ClearSemanticCacheError };

export interface ClearSemanticCacheOptions {
  signal?: AbortSignal;
  deploymentMode?: DeploymentMode;
}

/** The admin action never waits longer than this on the backend. */
export const SEMANTIC_CACHE_ADMIN_TIMEOUT_MS = 10_000;

function refuse(status: 400 | 503, error: ClearSemanticCacheError): ClearSemanticCacheResult {
  return { ok: false, status, error };
}

/**
 * D-44: deletes every cache entry of one tenant. The key must name a tenant of this deployment mode (and an existing organization or
 * user in multi-tenant mode); the backend's tenant invalidation runs on the service role and checks the key again in SQL or the
 * sidecar. Failures are reported, never served as 0.
 */
export async function clearTenantSemanticCache(tenantKey: unknown, options: ClearSemanticCacheOptions = {}): Promise<ClearSemanticCacheResult> {
  const parsed = parseTenantKey(tenantKey);
  const mode = options.deploymentMode ?? getDeploymentMode();
  if (!parsed || typeof tenantKey !== 'string') return refuse(400, 'invalid_tenant_key');
  if ((mode === 'multi-tenant') === (parsed.kind === 'single')) return refuse(400, 'invalid_tenant_key');

  const deps = getRagDeps();
  const backend = loadRagConfig(deps.ragEnv()).semanticCache.backend;
  if (backend === 'off') return { ok: true, deleted: 0, backend: 'off' };

  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(SEMANTIC_CACHE_ADMIN_TIMEOUT_MS)])
    : AbortSignal.timeout(SEMANTIC_CACHE_ADMIN_TIMEOUT_MS);
  const resolved = await backfillScope(tenantKey, { deploymentMode: mode, signal });
  if (!resolved.ok) {
    if (resolved.reason === 'unavailable') return refuse(503, 'semantic_cache_unavailable');
    return refuse(400, resolved.reason === 'unknown_tenant' ? 'unknown_tenant' : 'invalid_tenant_key');
  }
  const scope = resolved.scope;

  let cache;
  try {
    cache = deps.semanticCacheAdmin();
  } catch {
    cache = null;
  }
  if (!cache) {
    console.warn('[Semantic Cache] tenant clear unavailable', { backend, reason: 'backend_unconfigured', tenant: hashedTenantKey(scope) });
    return refuse(503, 'semantic_cache_unavailable');
  }

  try {
    const deleted = await cache.invalidateTenant(scope, undefined, { signal });
    if (!Number.isInteger(deleted) || deleted < 0) throw new Error('malformed_count');
    console.info('[Semantic Cache] tenant cleared', { backend, deleted, tenant: hashedTenantKey(scope) });
    return { ok: true, deleted, backend };
  } catch (error) {
    const reason = signal.aborted ? 'timeout' : error instanceof Error ? error.name.slice(0, 64) : 'unknown';
    console.warn('[Semantic Cache] tenant clear failed', { backend, reason, tenant: hashedTenantKey(scope) });
    return refuse(503, 'semantic_cache_unavailable');
  }
}
