import { rpcRows, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { isCanonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import type { VectorPoint, VectorStore } from './stores/types';

export const DRAIN_DEFAULT_BUDGET_MS = 45_000;
export const DRAIN_DEFAULT_BATCH = 100;
export const DRAIN_LEASE_SECONDS = 120;
const PAGE_LIMIT = 500;
const ERROR_CODE_RE = /^[a-z0-9_.:-]{1,200}$/;

interface OutboxRow {
  id: number | string;
  target: string;
  entity: 'chunk' | 'document' | 'profile' | 'tenant';
  entity_id: string;
  tenant_key: string | null;
  profile_id: string | null;
  enqueued_at: string;
}

interface SyncProfile {
  profile_id: string;
  dims: number;
  storage: string;
}

interface SyncRow {
  chunk_id: string;
  document_id: string;
  tenant_key: string;
  vector: number[] | string;
  lexical_text: string | null;
  lexical_version: number | null;
  content_hash: string | null;
  doc_type: string | null;
  doc_date: string | null;
  language: string | null;
  source: string | null;
  chunking_profile_id: string | null;
  parent_id: string | null;
}

export interface DrainSliceOptions {
  store: VectorStore;
  rpc: RpcClient;
  budgetMs?: number;
  batch?: number;
  now?: () => number;
}

class DrainError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`[Vector Sync] ${code}`);
    this.code = code;
  }
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown[]> {
  const signal = new AbortController().signal;
  const response = await rpc.rpc(fn, args).abortSignal(signal);
  if (response.error) throw new DrainError(`${fn}:${response.error.code ?? 'rpc_error'}`.toLowerCase());
  return rpcRows(response.data);
}

function toVector(value: number[] | string): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return String(value)
    .replace(/^[{[]|[}\]]$/g, '')
    .split(',')
    .filter((x) => x.length > 0)
    .map(Number);
}

/** D-03: the payload is built field by field, so content or a document name can never ride along. */
function toPoint(row: SyncRow): VectorPoint {
  return {
    id: String(row.chunk_id),
    vector: toVector(row.vector),
    payload: {
      tenant_key: row.tenant_key,
      document_id: String(row.document_id),
      doc_type: row.doc_type,
      doc_date: row.doc_date,
      language: row.language,
      source: row.source,
      chunking_profile_id: row.chunking_profile_id,
      parent_id: row.parent_id ? String(row.parent_id) : null,
      lexical_text: row.lexical_text,
      content_hash: row.content_hash,
      lexical_version: row.lexical_version,
    },
  };
}

function errorCode(error: unknown): string {
  const code = error instanceof DrainError ? error.code : 'drain_error';
  return ERROR_CODE_RE.test(code) ? code : 'drain_error';
}

/**
 * One time-sliced drain over one store (D-02, D-04): claim, read the current servable rows of each claimed entity, upsert them and
 * delete every other point of that entity, then complete. Rows are never trusted for content; the outbox only names what changed.
 */
export async function drainSlice(options: DrainSliceOptions): Promise<VectorSyncSliceReport> {
  const { store, rpc } = options;
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? DRAIN_DEFAULT_BUDGET_MS;
  const batch = options.batch ?? DRAIN_DEFAULT_BATCH;
  const started = now();
  const report = { claimed: 0, upserted: 0, deleted: 0, failed: 0, dead: 0, lagSeconds: 0 };
  let morePending = false;

  const profiles = (await call(rpc, 'rag_vector_sync_profiles', {})) as SyncProfile[];
  const profileById = new Map(profiles.map((profile) => [profile.profile_id, profile]));
  const ensured = new Set<string>();

  async function profilesFor(row: OutboxRow): Promise<SyncProfile[]> {
    const chosen = row.profile_id ? profiles.filter((p) => p.profile_id === row.profile_id) : profiles;
    for (const profile of chosen) {
      if (!ensured.has(profile.profile_id)) {
        await store.ensureCollection({ profileId: profile.profile_id, dims: profile.dims });
        ensured.add(profile.profile_id);
      }
    }
    return chosen;
  }

  async function syncDocument(tenantKey: string, documentId: string, profile: SyncProfile): Promise<void> {
    const points: VectorPoint[] = [];
    let after: string | null = null;
    for (;;) {
      const rows = (await call(rpc, 'rag_vector_sync_document_rows', {
        p_tenant_key: tenantKey,
        p_document_id: documentId,
        p_profile_id: profile.profile_id,
        p_after: after,
        p_limit: PAGE_LIMIT,
      })) as SyncRow[];
      for (const row of rows) points.push(toPoint(row));
      if (rows.length < PAGE_LIMIT) break;
      after = String(rows[rows.length - 1].chunk_id);
    }
    await store.ensureTenant(profile.profile_id, tenantKey);
    if (points.length > 0) report.upserted += await store.upsert(profile.profile_id, tenantKey, points);
    const keep = new Set(points.map((point) => point.id));
    const stale = (await store.listDocumentIds(profile.profile_id, tenantKey, documentId)).filter((id) => !keep.has(id));
    if (stale.length > 0) report.deleted += await store.deleteIds(profile.profile_id, tenantKey, stale);
  }

  async function syncChunk(tenantKey: string, chunkId: string, profile: SyncProfile): Promise<void> {
    const rows = (await call(rpc, 'rag_vector_sync_chunk_row', {
      p_tenant_key: tenantKey,
      p_chunk_id: chunkId,
      p_profile_id: profile.profile_id,
    })) as SyncRow[];
    await store.ensureTenant(profile.profile_id, tenantKey);
    if (rows.length > 0) report.upserted += await store.upsert(profile.profile_id, tenantKey, rows.map(toPoint));
    else report.deleted += await store.deleteIds(profile.profile_id, tenantKey, [chunkId]);
  }

  /** Returns true when the row is finished and can be completed. */
  async function processRow(row: OutboxRow): Promise<boolean> {
    if (row.entity === 'tenant' || row.entity === 'profile') {
      const [page] = (await call(rpc, 'rag_vector_sync_expand', { p_id: row.id, p_limit: batch })) as Array<{
        next_cursor: string | null;
        has_more: boolean;
      }>;
      if (page?.has_more) {
        await call(rpc, 'rag_vector_sync_checkpoint', { p_id: row.id, p_cursor: page.next_cursor });
        morePending = true;
        return false;
      }
      return true;
    }
    const tenantKey = row.tenant_key;
    if (!tenantKey || !isCanonicalTenantKey(tenantKey)) throw new DrainError('invalid_tenant_key');
    for (const profile of await profilesFor(row)) {
      if (row.entity === 'document') await syncDocument(tenantKey, row.entity_id, profile);
      else await syncChunk(tenantKey, row.entity_id, profile);
    }
    return true;
  }

  while (now() - started < budgetMs) {
    const claimed = (await call(rpc, 'rag_vector_sync_claim', { p_limit: batch, p_lease_seconds: DRAIN_LEASE_SECONDS })) as OutboxRow[];
    if (claimed.length === 0) {
      morePending = false;
      break;
    }
    report.claimed += claimed.length;
    const done: Array<number | string> = [];
    for (const row of claimed) {
      const lag = (now() - Date.parse(row.enqueued_at)) / 1000;
      if (Number.isFinite(lag) && lag > report.lagSeconds) report.lagSeconds = lag;
      if (row.target !== store.target) {
        await call(rpc, 'rag_vector_sync_fail', { p_id: row.id, p_error: 'target_unavailable' });
        report.failed += 1;
        continue;
      }
      if (row.profile_id && !profileById.has(row.profile_id)) {
        done.push(row.id);
        continue;
      }
      try {
        if (await processRow(row)) done.push(row.id);
      } catch (error) {
        const [state] = (await call(rpc, 'rag_vector_sync_fail', { p_id: row.id, p_error: errorCode(error) })) as unknown[];
        report.failed += 1;
        if (state === 'dead') report.dead += 1;
      }
    }
    if (done.length > 0) await call(rpc, 'rag_vector_sync_complete', { p_ids: done });
    morePending = claimed.length === batch || morePending;
  }
  if (now() - started >= budgetMs) morePending = true;

  const elapsed = Math.max(0, Math.round(now() - started));
  console.log(
    `[Vector Sync] ${JSON.stringify({ target: store.target, claimed: report.claimed, upserted: report.upserted, deleted: report.deleted, failed: report.failed, dead: report.dead, elapsed_ms: elapsed })}`,
  );
  return {
    mode: 'drain',
    claimed: report.claimed,
    upserted: report.upserted,
    deleted: report.deleted,
    failed: report.failed,
    dead: report.dead,
    lag_seconds: Math.max(0, Number(report.lagSeconds.toFixed(3))),
    elapsed_ms: elapsed,
    budget_ms: Math.max(0, Math.round(budgetMs)),
    more_pending: morePending,
  };
}

export async function drainUntilEmpty(options: DrainSliceOptions): Promise<VectorSyncSliceReport[]> {
  return [await drainSlice(options)];
}
