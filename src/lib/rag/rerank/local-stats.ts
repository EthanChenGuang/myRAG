import { createHash } from 'node:crypto';
import { logger } from '@/lib/logger';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { dropLexstatsReady, lexstatsReady } from '../lexical/stats';
import type { LocalStatsGroup, LocalStatsProvider } from './types';

/**
 * 04.4-21 D-55: the tenant statistics read of the local reranker (RAG_RERANK_LOCAL_STATS=tenant). One rag_lexical_rerank_stats call per
 * rerank call, on the admin client with the caller's scopeKey as the only tenant input; the readiness answer of the lexical statistics
 * cache (04.4-08) is reused, so a tenant known not to be ready costs no read. Every failure answers null and the pool serves.
 * Logs carry a tenant-key hash and a code only (D-34).
 */
export const RERANK_STATS_RPC = 'rag_lexical_rerank_stats';
export const MAX_STATS_TERMS = 64;
export const MAX_STATS_GROUPS = 64;
const GROUP_SEPARATOR = '\u001f';

export interface LocalStatsCandidate {
  docType: string | null;
  language: string | null;
}

function tenantHash(tenantKey: string): string {
  return createHash('sha256').update(tenantKey).digest('hex').slice(0, 12);
}

/** The statistics bucket of a chunk: its doc type (whose effective chunking profile the SQL resolves) and its language ('und' if none). */
export function localStatsGroupOf(candidate: LocalStatsCandidate): string | null {
  if (!candidate.docType) return null;
  return `${candidate.docType}${GROUP_SEPARATOR}${candidate.language || 'und'}`;
}

function splitGroup(group: string): [string, string] {
  const at = group.indexOf(GROUP_SEPARATOR);
  return [group.slice(0, at), group.slice(at + 1)];
}

function parseRows(data: unknown): Map<string, LocalStatsGroup> | null {
  const out = new Map<string, LocalStatsGroup>();
  for (const value of rpcRows(data)) {
    const row = value as Record<string, unknown>;
    const { terms, dfs, language } = row;
    const group = row['doc_type'];
    if (typeof group !== 'string' || typeof language !== 'string' || !Array.isArray(terms) || !Array.isArray(dfs)) return null;
    if (terms.length !== dfs.length) return null;
    const df = new Map<string, number>();
    terms.forEach((term, index) => {
      const count = Number(dfs[index]);
      if (typeof term === 'string' && Number.isFinite(count) && count > 0) df.set(term, count);
    });
    out.set(`${group}${GROUP_SEPARATOR}${language}`, {
      chunkCount: Number(row.chunk_count) || 0,
      totalLength: Number(row.total_len) || 0,
      df,
    });
  }
  return out;
}

export function createTenantLocalStatsProvider(args: {
  client: RpcClient;
  tenantKey: string;
  candidates: readonly LocalStatsCandidate[];
  chunkingOverride?: Record<string, string>;
}): LocalStatsProvider {
  const { client, tenantKey, chunkingOverride } = args;
  return {
    groupByDoc: args.candidates.map(localStatsGroupOf),
    async read(terms, groups, signal) {
      if (terms.length === 0 || terms.length > MAX_STATS_TERMS || groups.length === 0 || groups.length > MAX_STATS_GROUPS) return null;
      if (!(await lexstatsReady(client, tenantKey, Date.now(), signal))) return null;
      const pairs = groups.map(splitGroup);
      try {
        const response = await client
          .rpc(RERANK_STATS_RPC, {
            p_tenant_key: tenantKey,
            p_terms: terms,
            p_doc_types: pairs.map((pair) => pair[0]),
            p_languages: pairs.map((pair) => pair[1]),
            p_chunking_override: chunkingOverride ?? null,
          })
          .abortSignal(signal);
        if (response.error) {
          if (/lexical_stats_not_ready/.test(response.error.message)) dropLexstatsReady(tenantKey);
          else logger.warn('Document Search', 'rerank statistics read failed; pool statistics serve', { tenant: tenantHash(tenantKey), code: 'rerank_stats_unavailable' });
          return null;
        }
        return parseRows(response.data);
      } catch {
        if (!signal.aborted) {
          logger.warn('Document Search', 'rerank statistics read failed; pool statistics serve', { tenant: tenantHash(tenantKey), code: 'rerank_stats_unavailable' });
        }
        return null;
      }
    },
  };
}
