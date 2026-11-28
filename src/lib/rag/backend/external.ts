import type { StoreHit, VectorStore } from '../sync/stores/types';
import type { TenantScope } from '../tenant/scope';
import { logTenantValidationDropped, revalidateChunks, type SecurityLogSink, type ValidatedChunk } from './revalidate';
import type { RpcClient } from './supabase-rpc';
import { canonicalTenantKey } from './tenant-key';
import type { BackendHealth, BackendLegs, BackendSearchRequest, RankedHit, RetrievalBackend } from './types';

/** A store has no collection for the profile or no partition for the tenant; the factory (07-12) maps it to backend_not_ready. */
export class BackendNotReadyError extends Error {
  readonly backend: string;
  readonly reason: 'collection_missing' | 'tenant_missing';

  constructor(backend: string, reason: 'collection_missing' | 'tenant_missing') {
    super(`[RAG Backend] ${backend} not ready (${reason})`);
    this.name = 'BackendNotReadyError';
    this.backend = backend;
    this.reason = reason;
  }
}

export type ExternalStoreReader = Pick<VectorStore, 'target' | 'searchLegs' | 'health'>;

export interface ExternalBackendDeps {
  reader: ExternalStoreReader;
  adminClient: () => RpcClient | null;
  isReady?: (scope: TenantScope) => Promise<boolean>;
  securityLog?: SecurityLogSink;
}

function rebuildLeg(hits: StoreHit[], kept: Map<string, ValidatedChunk>, leg: 'dense' | 'lexical'): RankedHit[] {
  const out: RankedHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const id = String(hit.id);
    const chunk = kept.get(id);
    if (!chunk || seen.has(id)) continue;
    seen.add(id);
    const score = typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : null;
    out.push({
      ...chunk,
      rank: out.length + 1,
      similarity: leg === 'dense' ? score : null,
      lexicalScore: leg === 'lexical' ? score : null,
    });
  }
  return out;
}

/**
 * An external store answers ids and scores only; every id from both legs is re-validated in one rag_validate_chunks call and every hit
 * is hydrated from Supabase (D-03, D-10). Ids the database does not return are dropped, counted and alerted, and ranks are
 * renumbered per leg in store order.
 */
export function createExternalBackend(deps: ExternalBackendDeps): RetrievalBackend {
  const { reader } = deps;
  return {
    id: reader.target,
    async search(req: BackendSearchRequest): Promise<BackendLegs> {
      canonicalTenantKey(req.scope);
      const legs = await reader.searchLegs({
        scope: req.scope,
        profileId: req.embeddingProfileId,
        denseVector: req.denseVector && req.denseVector.length > 0 ? req.denseVector : null,
        lexicalTokens: req.lexicalTokens,
        denseLimit: req.denseLimit,
        lexicalLimit: req.lexicalLimit,
        filters: req.filters,
        signal: req.signal,
      });
      req.signal.throwIfAborted();
      const ids = [...legs.dense, ...legs.lexical].map((hit) => String(hit.id));
      const validated = await revalidateChunks(req.scope, ids, {
        client: deps.adminClient(),
        profileId: req.embeddingProfileId,
        signal: req.signal,
      });
      if (validated.dropped > 0) {
        logTenantValidationDropped(reader.target, validated.requested, validated.dropped, deps.securityLog);
      }
      return {
        dense: rebuildLeg(legs.dense, validated.chunks, 'dense'),
        lexical: rebuildLeg(legs.lexical, validated.chunks, 'lexical'),
        meta: { denseMode: null, tenantValidationDropped: validated.dropped },
      };
    },
    async health(): Promise<BackendHealth> {
      return reader.health();
    },
    async isReady(scope: TenantScope): Promise<boolean> {
      canonicalTenantKey(scope);
      return deps.isReady ? deps.isReady(scope) : false;
    },
  };
}
