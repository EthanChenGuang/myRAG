import type { RpcError, RpcResponse } from '../backend/supabase-rpc';
import { isTenantKey } from '../ingest/writer';

/** The part of a supabase-js query builder the tenant listing uses. */
export interface LexstatsQuery extends PromiseLike<{ data: unknown; error: RpcError | null }> {
  select(columns: string): LexstatsQuery;
  eq(column: string, value: unknown): LexstatsQuery;
  in(column: string, values: unknown[]): LexstatsQuery;
  gt(column: string, value: unknown): LexstatsQuery;
  order(column: string, options?: { ascending?: boolean }): LexstatsQuery;
  limit(count: number): LexstatsQuery;
}

/** The service-role admin client: the 0902 functions and the statistics tables are service_role only. */
export interface LexstatsDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResponse>;
  from(table: string): LexstatsQuery;
}

/** A failed call. Carries the rpc (or table) name and the error code only, never the message, the client or the tenant key. */
export class LexstatsRpcError extends Error {
  readonly rpc: string;
  readonly code: string;

  constructor(rpc: string, code: string | undefined) {
    const safe = code && /^[0-9A-Za-z_]{1,16}$/.test(code) ? code : 'unknown';
    super(`[Lexical Stats] ${rpc} failed (${safe})`);
    this.name = 'LexstatsRpcError';
    this.rpc = rpc;
    this.code = safe;
  }
}

export type LexstatsState = 'building' | 'ready';

export interface TenantStatsStatus {
  state: LexstatsState | null;
  chunkCount: number;
  lexemeCount: number;
  pending: number;
  oldestPendingAgeS: number | null;
}

export interface TenantStatsCheck {
  state: LexstatsState | null;
  pending: number;
  dfMismatch: number | null;
  dfMismatchWithPending: number | null;
  chunkCountDiff: number | null;
  chunkCountDiffWithPending: number | null;
  totalLenDiff: number | null;
  totalLenDiffWithPending: number | null;
  /** null when the tenant keeps no statistics. */
  clean: boolean | null;
}

export interface TenantStatsRebuild {
  chunkCount: number;
  lexemeRows: number;
  corpusRows: number;
}

export const DEFAULT_COMPACT_MAX_ROWS = 5000;
const MEMBER_STATUSES = ['ready', 'variant'];

async function call(db: LexstatsDb, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new LexstatsRpcError(fn, error.code);
  return data;
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function stateOf(value: unknown): LexstatsState | null {
  return value === 'building' || value === 'ready' ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Inserts the state row (`building`); returns the state after the call. Its own call, so it is committed before the rebuild (D-18). */
export async function enableTenantStats(db: LexstatsDb, tenantKey: string): Promise<LexstatsState> {
  const state = stateOf(await call(db, 'rag_lexstats_enable', { p_tenant_key: tenantKey }));
  if (!state) throw new LexstatsRpcError('rag_lexstats_enable', 'bad_answer');
  return state;
}

export async function rebuildTenantStats(db: LexstatsDb, tenantKey: string): Promise<TenantStatsRebuild> {
  const r = record(await call(db, 'rag_lexstats_rebuild', { p_tenant_key: tenantKey }));
  return { chunkCount: num(r.chunk_count), lexemeRows: num(r.lexeme_rows), corpusRows: num(r.corpus_rows) };
}

/** One compaction batch of at most maxRows pending rows; returns the rows folded (0 when nothing is left). */
export async function compactTenantStats(db: LexstatsDb, tenantKey: string, maxRows = DEFAULT_COMPACT_MAX_ROWS): Promise<number> {
  return num(await call(db, 'rag_lexstats_compact', { p_tenant_key: tenantKey, p_max_rows: maxRows }));
}

export async function statusTenantStats(db: LexstatsDb, tenantKey: string): Promise<TenantStatsStatus> {
  const r = record(await call(db, 'rag_lexstats_status', { p_tenant_key: tenantKey }));
  return {
    state: stateOf(r.state),
    chunkCount: num(r.chunk_count),
    lexemeCount: num(r.lexeme_count),
    pending: num(r.pending),
    oldestPendingAgeS: numOrNull(r.oldest_pending_age_s),
  };
}

export async function checkTenantStats(db: LexstatsDb, tenantKey: string): Promise<TenantStatsCheck> {
  const r = record(await call(db, 'rag_lexstats_check', { p_tenant_key: tenantKey }));
  return {
    state: stateOf(r.state),
    pending: num(r.pending),
    dfMismatch: numOrNull(r.df_mismatch),
    dfMismatchWithPending: numOrNull(r.df_mismatch_with_pending),
    chunkCountDiff: numOrNull(r.chunk_count_diff),
    chunkCountDiffWithPending: numOrNull(r.chunk_count_diff_with_pending),
    totalLenDiff: numOrNull(r.total_len_diff),
    totalLenDiffWithPending: numOrNull(r.total_len_diff_with_pending),
    clean: typeof r.clean === 'boolean' ? r.clean : null,
  };
}

/** Removes every statistics row of the tenant; returns whether a state row existed. */
export async function disableTenantStats(db: LexstatsDb, tenantKey: string): Promise<boolean> {
  return (await call(db, 'rag_lexstats_disable', { p_tenant_key: tenantKey })) === true;
}

/**
 * Tenant keys in key order. `chunks`: distinct tenant keys of member chunks (current, ready or variant), one keyset step per key
 * (`gt` on the last key, limit 1), so no distinct query or extra RPC is needed. `enabled`: the tenants with a state row, in pages.
 */
export async function* listStatsTenants(db: LexstatsDb, source: 'chunks' | 'enabled', pageSize = 500): AsyncGenerator<string> {
  let last: string | null = null;
  const table = source === 'chunks' ? 'document_chunks' : 'rag_lexical_stats_state';
  const limit = source === 'chunks' ? 1 : pageSize;
  for (;;) {
    let query = db.from(table).select('tenant_key');
    if (source === 'chunks') query = query.eq('is_current', true).in('status', MEMBER_STATUSES);
    if (last !== null) query = query.gt('tenant_key', last);
    const { data, error } = await query.order('tenant_key', { ascending: true }).limit(limit);
    if (error) throw new LexstatsRpcError(table, error.code);
    const rows = Array.isArray(data) ? (data as Array<{ tenant_key?: unknown }>) : [];
    let advanced = false;
    for (const row of rows) {
      const key = typeof row.tenant_key === 'string' ? row.tenant_key : null;
      if (key === null) return;
      if (last !== null && key <= last) continue;
      last = key;
      advanced = true;
      if (isTenantKey(key)) yield key;
    }
    if (!advanced || rows.length < limit) return;
  }
}
