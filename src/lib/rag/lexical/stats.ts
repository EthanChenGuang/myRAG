import type { SupabaseClient } from '@supabase/supabase-js';
import type { RpcClient } from '../backend/supabase-rpc';

/** D-25: how long one tenant's readiness answer is reused before rag_lexstats_status is read again. */
export const LEXSTATS_READY_TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

interface ReadyEntry {
  ready: boolean;
  /** D-49: cluster_status 'ready' in the same status answer (only for a tenant whose raw statistics are ready). */
  clusterReady: boolean;
  at: number;
}

/** Readiness of one tenant: raw statistics (D-25) and the cluster-aware corpus (D-49). */
export interface LexstatsReadiness {
  ready: boolean;
  clusterReady: boolean;
}

/** Keyed by the verified scopeKey; values carry booleans only. */
const readyCache = new Map<string, ReadyEntry>();

const STATUS_RPC = 'rag_lexstats_status';

/** The jsonb answer itself, or the single value of a one-row answer keyed by the function name. */
function statusValue(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  if (data.length !== 1) return null;
  const row = data[0] as Record<string, unknown> | null;
  return row && typeof row === 'object' && STATUS_RPC in row ? row[STATUS_RPC] : row;
}

const NOT_READY: LexstatsReadiness = { ready: false, clusterReady: false };

function readinessFrom(data: unknown): LexstatsReadiness {
  const value = statusValue(data);
  if (!value || typeof value !== 'object') return NOT_READY;
  const status = value as { state?: unknown; chunk_count?: unknown; cluster_status?: unknown };
  const ready = status.state === 'ready' && typeof status.chunk_count === 'number' && status.chunk_count > 0;
  return { ready, clusterReady: ready && status.cluster_status === 'ready' };
}

function remember(tenantKey: string, readiness: LexstatsReadiness, now: number): void {
  readyCache.delete(tenantKey);
  readyCache.set(tenantKey, { ...readiness, at: now });
  while (readyCache.size > MAX_ENTRIES) {
    const oldest = readyCache.keys().next().value;
    if (oldest === undefined) break;
    readyCache.delete(oldest);
  }
}

/**
 * Whether the tenant's lexical statistics are ready (state 'ready' and at least one chunk). Never throws: an error, a missing
 * function or a rejected call reads as not ready and is cached like any other answer. An aborted signal is not cached.
 */
export async function lexstatsReady(client: RpcClient, tenantKey: string, now: number = Date.now(), signal?: AbortSignal): Promise<boolean> {
  return (await lexstatsReadiness(client, tenantKey, now, signal)).ready;
}

/** lexstatsReady plus D-49 cluster readiness, from the same rag_lexstats_status read and cache entry (no extra RPC). */
export async function lexstatsReadiness(
  client: RpcClient,
  tenantKey: string,
  now: number = Date.now(),
  signal?: AbortSignal,
): Promise<LexstatsReadiness> {
  const cached = readyCache.get(tenantKey);
  if (cached && now - cached.at < LEXSTATS_READY_TTL_MS) return { ready: cached.ready, clusterReady: cached.clusterReady };
  let readiness = NOT_READY;
  try {
    const request = client.rpc(STATUS_RPC, { p_tenant_key: tenantKey });
    const response = await (signal ? request.abortSignal(signal) : request);
    readiness = response.error ? NOT_READY : readinessFrom(response.data);
  } catch {
    if (signal?.aborted) return NOT_READY;
    readiness = NOT_READY;
  }
  remember(tenantKey, readiness, now);
  return readiness;
}

/** Forgets one tenant, so the next request reads the status again (after a lexical_stats_not_ready or lexical_cluster_stats_not_ready answer). */
export function dropLexstatsReady(tenantKey: string): void {
  readyCache.delete(tenantKey);
}

/** Startup only: how many tenants have ready statistics (a count, never keys); null when it cannot be read. */
export async function countReadyLexstatsTenants(client: SupabaseClient): Promise<number | null> {
  try {
    const { count, error } = await client
      .from('rag_lexical_stats_state')
      .select('tenant_key', { count: 'exact', head: true })
      .eq('status', 'ready');
    if (error || typeof count !== 'number') return null;
    return count;
  } catch {
    return null;
  }
}

/** D-49: tenants whose cluster-aware statistics (corpus chunks_cluster) are ready; a count, never a tenant key. */
export async function countReadyClusterLexstatsTenants(client: SupabaseClient): Promise<number | null> {
  try {
    const { count, error } = await client
      .from('rag_lexical_stats_state')
      .select('tenant_key', { count: 'exact', head: true })
      .eq('cluster_status', 'ready');
    if (error || typeof count !== 'number') return null;
    return count;
  } catch {
    return null;
  }
}

export function resetLexstatsCacheForTests(): void {
  readyCache.clear();
}
