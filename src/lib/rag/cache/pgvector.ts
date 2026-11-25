import { CachedAnswerSchema, type CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import type { SemanticCacheConfig } from '../config';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { computeCacheKeyHash } from './keys';
import type { CacheCallOptions, CacheHit, CacheQuery, SemanticCache } from './types';
import { SemanticCacheBackendError, halfvecLiteral, maskQueryText, resolveMaxDistance, scalarOf } from './wire';

export interface PgvectorSemanticCacheOptions {
  /** The service-role client: the cache functions are executable by service_role only. */
  adminClient: () => RpcClient | null;
  config: Pick<SemanticCacheConfig, 'ttl' | 'refusalTtl' | 'maxDistance'>;
}

interface CheckRow {
  hit?: unknown;
  entry_id?: unknown;
  distance?: unknown;
  answer?: unknown;
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> {
  const request = client.rpc(fn, args);
  const response = await (signal ? request.abortSignal(signal) : request);
  if (response.error) throw new SemanticCacheBackendError('rpc_error', response.error.code ?? null);
  return response.data;
}

/** The default backend (D-34): rag_cache_check / rag_cache_store / rag_cache_invalidate with p_tenant_key from the TenantScope only. */
export function createPgvectorSemanticCache(options: PgvectorSemanticCacheOptions): SemanticCache {
  const client = (): RpcClient => {
    const admin = options.adminClient();
    if (!admin) throw new SemanticCacheBackendError('not_configured');
    return admin;
  };

  return {
    async check(q: CacheQuery): Promise<CacheHit | null> {
      const args = {
        p_tenant_key: scopeKey(q.scope),
        p_key_hash: computeCacheKeyHash(q),
        p_profile: q.embeddingProfileId,
        p_embedding: halfvecLiteral(q.vector),
        p_max_distance: resolveMaxDistance(q.maxDistance, options.config.maxDistance),
      };
      const data = await call(client(), 'rag_cache_check', args, q.signal);
      const row = rpcRows(data)[0] as CheckRow | undefined;
      if (!row || row.hit !== true) return null;
      if (typeof row.entry_id !== 'string' || typeof row.distance !== 'number' || !Number.isFinite(row.distance)) return null;
      const parsed = CachedAnswerSchema.safeParse(row.answer);
      if (!parsed.success) return null;
      return { entryId: row.entry_id, distance: row.distance, answer: parsed.data };
    },

    async store(q: CacheQuery, answer: CachedAnswer): Promise<void> {
      const parsed = CachedAnswerSchema.safeParse(answer);
      if (!parsed.success) throw new SemanticCacheBackendError('invalid_answer');
      const value = parsed.data;
      const args = {
        p_tenant_key: scopeKey(q.scope),
        p_key_hash: computeCacheKeyHash(q),
        p_profile: q.embeddingProfileId,
        p_embedding: halfvecLiteral(q.vector),
        p_query_text_masked: maskQueryText(q.standalone),
        p_answer: value,
        p_source_versions: value.source_versions ?? [],
        p_is_refusal: value.is_refusal,
        p_ttl_seconds: value.is_refusal ? options.config.refusalTtl : options.config.ttl,
      };
      await call(client(), 'rag_cache_store', args, q.signal);
    },

    async invalidateTenant(scope: TenantScope, documentIds?: string[], opts?: CacheCallOptions): Promise<number> {
      const args = { p_tenant_key: scopeKey(scope), p_document_ids: documentIds ?? null };
      const data = await call(client(), 'rag_cache_invalidate', args, opts?.signal);
      const count = scalarOf(data, 'rag_cache_invalidate');
      const n = typeof count === 'string' ? Number(count) : count;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new SemanticCacheBackendError('malformed_response');
      return n;
    },
  };
}
