import {
  CacheCheckRequestSchema,
  CacheCheckResponseSchema,
  CacheInvalidateRequestSchema,
  CacheInvalidateResponseSchema,
  CacheStoreRequestSchema,
  CachedAnswerSchema,
  type CachedAnswer,
} from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import type { SemanticCacheConfig } from '../config';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { computeCacheKeyHash } from './keys';
import type { CacheCallOptions, CacheHit, CacheQuery, SemanticCache } from './types';
import { SemanticCacheBackendError, maskQueryText, requireFiniteVector, resolveMaxDistance, scalarOf } from './wire';

const SECRET_HEADER = 'x-sidecar-secret';
const CHECK_PATH = '/v1/cache/check';
const STORE_PATH = '/v1/cache/store';
const INVALIDATE_PATH = '/v1/cache/invalidate';

export interface RedisvlSemanticCacheOptions {
  /** RAG_SIDECAR_URL. */
  url: string;
  /** RAG_SIDECAR_SECRET, sent as x-sidecar-secret on every call. */
  secret: string;
  fetch: typeof fetch;
  /** The service-role client, for rag_cache_sources_current on every hit. */
  adminClient: () => RpcClient | null;
  config: Pick<SemanticCacheConfig, 'ttl' | 'maxDistance'>;
}

/**
 * The optional RedisVL backend (D-35) behind the sidecar's /v1/cache/* endpoints. Refusals are never stored or served: a RedisVL entry
 * cannot be invalidated in the same transaction as an upload, publish or delete (plan-check W1). A hit is re-validated against
 * rag_cache_sources_current; a stale hit is a miss plus a best-effort invalidation.
 */
export function createRedisvlSemanticCache(options: RedisvlSemanticCacheOptions): SemanticCache {
  const baseUrl = options.url.trim().replace(/\/+$/, '');
  const secret = options.secret.trim();

  async function post(path: string, body: unknown, signal: AbortSignal | undefined, readBody = true): Promise<unknown> {
    if (!baseUrl || !secret) throw new SemanticCacheBackendError('not_configured');
    const response = await options.fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SemanticCacheBackendError(`http_${response.status}`);
    }
    if (!readBody) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SemanticCacheBackendError('malformed_response');
    }
  }

  async function sourcesCurrent(scope: TenantScope, answer: CachedAnswer, signal: AbortSignal | undefined): Promise<boolean> {
    const client = options.adminClient();
    if (!client) throw new SemanticCacheBackendError('sources_unverifiable');
    const request = client.rpc('rag_cache_sources_current', {
      p_tenant_key: scopeKey(scope),
      p_source_versions: answer.source_versions ?? [],
    });
    const response = await (signal ? request.abortSignal(signal) : request);
    if (response.error) throw new SemanticCacheBackendError('rpc_error', response.error.code ?? null);
    const value = scalarOf(response.data, 'rag_cache_sources_current');
    if (typeof value !== 'boolean') throw new SemanticCacheBackendError('malformed_response');
    return value;
  }

  async function invalidateTenant(scope: TenantScope, documentIds?: string[], opts?: CacheCallOptions): Promise<number> {
    if (documentIds !== undefined && documentIds.length === 0) return 0;
    const request = CacheInvalidateRequestSchema.safeParse({ tenant_key: scopeKey(scope), document_ids: documentIds ?? null });
    if (!request.success) throw new SemanticCacheBackendError('invalid_request');
    const parsed = CacheInvalidateResponseSchema.safeParse(await post(INVALIDATE_PATH, request.data, opts?.signal));
    if (!parsed.success) throw new SemanticCacheBackendError('malformed_response');
    return parsed.data.deleted;
  }

  return {
    async check(q: CacheQuery): Promise<CacheHit | null> {
      const maxDistance = resolveMaxDistance(q.maxDistance, options.config.maxDistance);
      const request = CacheCheckRequestSchema.safeParse({
        tenant_key: scopeKey(q.scope),
        key_hash: computeCacheKeyHash(q),
        embedding_profile_id: q.embeddingProfileId,
        max_distance: maxDistance,
        vector: requireFiniteVector(q.vector),
      });
      if (!request.success) throw new SemanticCacheBackendError('invalid_request');
      const parsed = CacheCheckResponseSchema.safeParse(await post(CHECK_PATH, request.data, q.signal));
      if (!parsed.success) throw new SemanticCacheBackendError('malformed_response');
      const body = parsed.data;
      if (!body.hit || body.answer === null) return null;
      if (body.entry_id === null || body.distance === null) throw new SemanticCacheBackendError('malformed_response');
      if (body.answer.is_refusal) return null;
      if (body.distance > maxDistance) return null;

      if (!(await sourcesCurrent(q.scope, body.answer, q.signal))) {
        const ids = [...new Set((body.answer.source_versions ?? []).map((source) => source.document_id))];
        void invalidateTenant(q.scope, ids.length > 0 ? ids : undefined).catch(() => undefined);
        return null;
      }
      return { entryId: body.entry_id, distance: body.distance, answer: body.answer };
    },

    async store(q: CacheQuery, answer: CachedAnswer): Promise<void> {
      const value = CachedAnswerSchema.safeParse(answer);
      if (!value.success) throw new SemanticCacheBackendError('invalid_answer');
      if (value.data.is_refusal) return;
      const request = CacheStoreRequestSchema.safeParse({
        tenant_key: scopeKey(q.scope),
        key_hash: computeCacheKeyHash(q),
        embedding_profile_id: q.embeddingProfileId,
        vector: requireFiniteVector(q.vector),
        query_text_masked: maskQueryText(q.standalone),
        answer: value.data,
        ttl_seconds: options.config.ttl,
      });
      if (!request.success) throw new SemanticCacheBackendError('invalid_request');
      await post(STORE_PATH, request.data, q.signal, false);
    },

    invalidateTenant,
  };
}
