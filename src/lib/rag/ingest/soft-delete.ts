import type { RpcClient } from '../backend/supabase-rpc';
import { redisvlInvalidationTarget } from '../cache/emit';
import { scheduleAfterResponse } from '../trace/schedule';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { getIngestDeps } from './deps';
import type { IngestSource } from './types';

type Row = Record<string, unknown>;

const SQL_REASONS = new Set(['tenant_mismatch', 'invalid_argument', 'invalid_source', 'invalid_tenant_key'] as const);

export type SoftDeleteFailure = (typeof SQL_REASONS extends Set<infer T> ? T : never) | 'unavailable';

export type SoftDeleteResult =
  | { ok: true; outcome: 'deleted' | 'already_deleted'; lineageId: string; jobId: string | null }
  | { ok: false; reason: SoftDeleteFailure };

export interface SoftDeleteLineageOptions {
  signal: AbortSignal;
  deps?: { db: () => RpcClient | null };
}

function failureOf(message: string | undefined, code: string | null | undefined): SoftDeleteFailure {
  if (code === '22023') {
    const word = /^[a-z_]+/.exec(message ?? '')?.[0];
    if (word !== undefined && (SQL_REASONS as ReadonlySet<string>).has(word)) return word as SoftDeleteFailure;
    if (/^ingest_refused:/.test(message ?? '')) return 'invalid_tenant_key';
    return 'tenant_mismatch';
  }
  return 'unavailable';
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);
}

async function callRpc(
  rpc: string,
  args: Record<string, unknown>,
  options: SoftDeleteLineageOptions,
): Promise<{ ok: true; rows: Row[] } | { ok: false; reason: SoftDeleteFailure }> {
  const db = (options.deps ?? { db: () => getIngestDeps().db() }).db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    options.signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(options.signal);
    options.signal.throwIfAborted();
    if (response.error) {
      const reason = failureOf(response.error.message, response.error.code);
      if (reason === 'unavailable') console.error('[RAG Ingest] soft delete failed', { rpc, code: response.error.code ?? null });
      return { ok: false, reason };
    }
    return { ok: true, rows: (response.data ?? []) as Row[] };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    console.error('[RAG Ingest] soft delete failed', { rpc, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

/** The only application entry to rag_soft_delete_document (D-27). */
export async function softDeleteLineage(
  scope: TenantScope,
  lineageId: string,
  source: IngestSource,
  options: SoftDeleteLineageOptions,
): Promise<SoftDeleteResult> {
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope).toLowerCase();
  const called = await callRpc(
    'rag_soft_delete_document',
    { p_tenant_key: tenantKey, p_lineage_id: lineageId, p_source: source },
    options,
  );
  if (!called.ok) return { ok: false, reason: called.reason };
  const row = called.rows[0];
  if (!row) return { ok: false, reason: 'unavailable' };
  const outcome = text(row, 'outcome');
  if (outcome !== 'deleted' && outcome !== 'already_deleted') return { ok: false, reason: 'unavailable' };
  const returnedLineage = text(row, 'lineage_id');
  if (returnedLineage !== lineageId) return { ok: false, reason: 'unavailable' };
  const jobId = text(row, 'job_id');
  const cache = redisvlInvalidationTarget();
  if (cache) {
    // The lineage is not a document id: the whole tenant is invalidated.
    scheduleAfterResponse(async () => {
      await cache.invalidateTenant(scope);
    });
  }
  return {
    ok: true,
    outcome,
    lineageId,
    jobId: jobId === null ? null : jobId,
  };
}