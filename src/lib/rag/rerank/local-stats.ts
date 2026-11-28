import { createHash } from 'node:crypto';
import { logger } from '@/lib/logger';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { dropLexstatsReady, lexstatsReady } from '../lexical/stats';
import type { LocalStatsGroup, LocalStatsProvider } from './types';

/**
 * 04.4-21 D-55: the tenant statistics read of the local reranker (RAG_RERANK_LOCAL_STATS=tenant). One rag_lexical_rerank_stats call per
 * rerank call, on the admin client with the caller's scopeKey as the only tenant input. Each candidate is keyed by its chunk id; the SQL
 * resolves the chunk's own chunking profile and language inside the caller's tenant, so a chunk of another tenant or an unknown id gets
 * no statistics and the pool serves. The readiness answer of the lexical statistics cache (04.4-08) is reused, so a tenant known not to
 * be ready costs no read. Every failure answers null. Logs carry a tenant-key hash and a code only (D-34).
 */
export const RERANK_STATS_RPC = 'rag_lexical_rerank_stats';
export const MAX_STATS_TERMS = 64;
export const MAX_STATS_CHUNKS = 500;

function tenantHash(tenantKey: string): string {
  return createHash('sha256').update(tenantKey).digest('hex').slice(0, 12);
}

function logUnavailable(tenantKey: string): void {
  logger.warn('Document Search', 'rerank statistics read failed; pool statistics serve', { tenant: tenantHash(tenantKey), code: 'rerank_stats_unavailable' });
}

function parseRows(data: unknown): Map<string, LocalStatsGroup> | null {
  const out = new Map<string, LocalStatsGroup>();
  for (const value of rpcRows(data)) {
    const row = value as Record<string, unknown>;
    const { chunk_id: chunkId, terms, dfs } = row;
    if (typeof chunkId !== 'string' || !Array.isArray(terms) || !Array.isArray(dfs) || terms.length !== dfs.length) return null;
    const df = new Map<string, number>();
    terms.forEach((term, index) => {
      const count = Number(dfs[index]);
      if (typeof term === 'string' && Number.isFinite(count) && count > 0) df.set(term, count);
    });
    out.set(chunkId, { chunkCount: Number(row.chunk_count) || 0, totalLength: Number(row.total_len) || 0, df });
  }
  return out;
}

export function createTenantLocalStatsProvider(args: { client: RpcClient; tenantKey: string; chunkIds: readonly string[] }): LocalStatsProvider {
  const { client, tenantKey } = args;
  return {
    groupByDoc: args.chunkIds.map((id) => (id ? id : null)),
    async read(terms, groups, signal) {
      if (terms.length === 0 || terms.length > MAX_STATS_TERMS || groups.length === 0 || groups.length > MAX_STATS_CHUNKS) return null;
      if (!(await lexstatsReady(client, tenantKey, Date.now(), signal))) return null;
      try {
        const response = await client.rpc(RERANK_STATS_RPC, { p_tenant_key: tenantKey, p_terms: terms, p_chunk_ids: groups }).abortSignal(signal);
        if (response.error) {
          if (/lexical_stats_not_ready/.test(response.error.message)) dropLexstatsReady(tenantKey);
          else logUnavailable(tenantKey);
          return null;
        }
        return parseRows(response.data);
      } catch {
        if (!signal.aborted) logUnavailable(tenantKey);
        return null;
      }
    },
  };
}
