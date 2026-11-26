export type ClearSemanticCacheResult =
  | { ok: true; deleted: number; backend: 'off' | 'pgvector' | 'redisvl' }
  | { ok: false; status: 400 | 503; error: 'invalid_tenant_key' | 'unknown_tenant' | 'semantic_cache_unavailable' };

export async function clearTenantSemanticCache(_tenantKey: string): Promise<ClearSemanticCacheResult> {
  return { ok: false, status: 503, error: 'semantic_cache_unavailable' };
}
