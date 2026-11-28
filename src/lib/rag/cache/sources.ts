import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { scopeKey, type TenantScope } from '../tenant/scope';
import type { CacheHit } from './types';
import { SemanticCacheBackendError } from './wire';

export interface ResolvedSource {
  name: string;
  version: number;
}

export interface ResolveSourcesOptions {
  /** The service-role client: rag_cache_resolve_sources is executable by service_role only. */
  client: RpcClient | null;
  signal?: AbortSignal;
}

/** The current, ready version of each document of the request's tenant (rag_cache_resolve_sources); absent ids no longer resolve. */
export async function resolveCachedSources(
  scope: TenantScope,
  documentIds: readonly string[],
  options: ResolveSourcesOptions,
): Promise<Map<string, ResolvedSource>> {
  const resolved = new Map<string, ResolvedSource>();
  if (documentIds.length === 0) return resolved;
  if (!options.client) throw new SemanticCacheBackendError('not_configured');
  const request = options.client.rpc('rag_cache_resolve_sources', {
    p_tenant_key: scopeKey(scope),
    p_document_ids: [...new Set(documentIds)],
  });
  const response = await (options.signal ? request.abortSignal(options.signal) : request);
  if (response.error) throw new SemanticCacheBackendError('rpc_error', response.error.code ?? null);
  for (const row of rpcRows(response.data) as Array<Record<string, unknown>>) {
    const id = row?.document_id;
    const name = row?.name;
    const version = row?.version;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new SemanticCacheBackendError('malformed_response');
    }
    resolved.set(id, { name, version });
  }
  return resolved;
}

/** The answer with every citation and source renamed to the current document; null when a cited document no longer resolves. */
export function withCurrentSources(answer: CachedAnswer, resolved: ReadonlyMap<string, ResolvedSource>): CachedAnswer | null {
  const citations = answer.citations ?? [];
  if (citations.some((citation) => !resolved.has(citation.documentId))) return null;
  return {
    ...answer,
    ...(answer.citations
      ? {
          citations: citations.map((citation) => {
            const current = resolved.get(citation.documentId)!;
            return { ...citation, documentName: current.name, documentVersion: current.version };
          }),
        }
      : {}),
    ...(answer.sources
      ? {
          sources: answer.sources.map((source) => {
            const current = resolved.get(source.document_id);
            return current ? { ...source, name: current.name, version: current.version } : source;
          }),
        }
      : {}),
  };
}

export type HitResolution = { kind: 'hit'; hit: CacheHit } | { kind: 'unresolved' };

/** W6: a hit's citations are re-resolved under the request's TenantScope; a hit without citations makes no call. */
export async function resolveHitSources(scope: TenantScope, hit: CacheHit, options: ResolveSourcesOptions): Promise<HitResolution> {
  const citations = hit.answer.citations ?? [];
  if (citations.length === 0) return { kind: 'hit', hit };
  const resolved = await resolveCachedSources(
    scope,
    citations.map((citation) => citation.documentId),
    options,
  );
  const answer = withCurrentSources(hit.answer, resolved);
  return answer ? { kind: 'hit', hit: { ...hit, answer } } : { kind: 'unresolved' };
}
