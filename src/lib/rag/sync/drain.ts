import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { RetrievalBackendError, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { isCanonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import { VectorSyncSliceReportSchema, type VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import {
  checkpointRow,
  claimBatch,
  completeRows,
  expandRow,
  failRow,
  readChunkRow,
  readDocumentRows,
  readSyncProfiles,
  type OutboxRow,
  type SyncProfile,
} from './claim';
import { planChunkSync, planDocumentSync, type SyncPlan } from './servable';
import type { VectorStore } from './stores/types';

export const DRAIN_DEFAULT_BUDGET_MS = 45_000;
export const DRAIN_DEFAULT_BATCH = 100;
export const DRAIN_LEASE_SECONDS = 120;
export const DRAIN_DEFAULT_PAGE = 100;
const DEFAULT_MAX_SLICES = 10_000;
const ERROR_CODE_RE = /^[a-z0-9_.:-]{1,200}$/;
/** A cursor that means "from the start": every chunk and document id sorts after it, and expand accepts it as a uuid. */
const RESTART_CURSOR = '00000000-0000-0000-0000-000000000000';
const CURSOR_SEPARATOR = '@';

export interface DrainSliceOptions {
  /** One store, or several (one per enabled target). Rows of a target without a store fail with target_unavailable. */
  store?: VectorStore;
  stores?: VectorStore[];
  rpc: RpcClient;
  budgetMs?: number;
  batch?: number;
  leaseSeconds?: number;
  pageSize?: number;
  now?: () => number;
  sink?: (line: string) => void;
}

export interface DrainUntilEmptyOptions extends DrainSliceOptions {
  maxSlices?: number;
}

class DrainError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`[Vector Sync] ${code}`);
    this.code = code;
  }
}

interface Group {
  key: string;
  rows: OutboxRow[];
  head: OutboxRow;
}

type GroupOutcome = 'done' | 'checkpointed';

/** ensureCollection runs once per (store, profile) per process; a collection reported missing is ensured again. */
const ensuredCollections = new WeakMap<VectorStore, Set<string>>();

function groupKey(row: OutboxRow): string {
  return JSON.stringify([row.target, row.entity, row.entity_id, row.tenant_key, row.profile_id]);
}

/** D-04: rows naming the same (target, entity, entity_id, tenant_key, profile_id) are processed once. */
function coalesce(rows: OutboxRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = groupKey(row);
    const found = groups.get(key);
    if (found) found.rows.push(row);
    else groups.set(key, { key, rows: [row], head: row });
  }
  return [...groups.values()];
}

function isFresh(cursor: string | null | undefined): boolean {
  return cursor === null || cursor === undefined || cursor === '' || cursor === RESTART_CURSOR;
}

/** One resume point for the group: a fresh row anywhere in the group restarts the whole entity; otherwise the rows must agree. */
function groupCursor(group: Group): string | null {
  const cursors = group.rows.map((row) => row.cursor);
  if (cursors.some(isFresh)) return null;
  return cursors.every((cursor) => cursor === cursors[0]) ? (cursors[0] as string) : null;
}

function parseDocumentCursor(cursor: string | null): { profileId: string; after: string } | null {
  if (cursor === null) return null;
  const at = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (at <= 0) return null;
  return { profileId: cursor.slice(0, at), after: cursor.slice(at + 1) };
}

function codeOf(error: unknown): string {
  let code = 'store_error';
  if (error instanceof DrainError) code = error.code;
  else if (error instanceof RetrievalBackendError) code = `${error.rpc}:${error.code ?? 'rpc_error'}`.toLowerCase();
  else if (error instanceof BackendNotReadyError) code = `backend_not_ready:${error.reason}`;
  return ERROR_CODE_RE.test(code) ? code : 'drain_error';
}

function isTenantMissing(error: unknown): boolean {
  return error instanceof BackendNotReadyError && error.reason === 'tenant_missing';
}

/**
 * One time-sliced drain (D-02, D-04, A-12): claim batches, coalesce them by entity, re-sync each entity from Supabase's current
 * servable rows, and complete, checkpoint or fail every claimed row. The loop is bounded by its own budget, never by a request's
 * abort signal (research Pitfall 9): once the budget is spent no new batch is claimed and no new group starts.
 */
export async function drainSlice(options: DrainSliceOptions): Promise<VectorSyncSliceReport> {
  const { rpc } = options;
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? DRAIN_DEFAULT_BUDGET_MS;
  const batch = options.batch ?? DRAIN_DEFAULT_BATCH;
  const leaseSeconds = options.leaseSeconds ?? DRAIN_LEASE_SECONDS;
  const pageSize = options.pageSize ?? DRAIN_DEFAULT_PAGE;
  const stores = new Map<string, VectorStore>();
  for (const store of [...(options.stores ?? []), ...(options.store ? [options.store] : [])]) stores.set(store.target, store);

  const started = now();
  const spent = (): boolean => now() - started >= budgetMs;
  const counts = { claimed: 0, upserted: 0, deleted: 0, failed: 0, dead: 0, lagSeconds: 0 };
  let morePending = false;
  let profiles: SyncProfile[] | null = null;

  async function syncedProfiles(): Promise<SyncProfile[]> {
    if (profiles === null) profiles = [...(await readSyncProfiles(rpc))].sort((a, b) => (a.profile_id < b.profile_id ? -1 : 1));
    return profiles;
  }

  async function ensureCollection(store: VectorStore, profile: SyncProfile): Promise<void> {
    let seen = ensuredCollections.get(store);
    if (!seen) {
      seen = new Set();
      ensuredCollections.set(store, seen);
    }
    if (seen.has(profile.profile_id)) return;
    await store.ensureCollection({ profileId: profile.profile_id, dims: profile.dims });
    seen.add(profile.profile_id);
  }

  function forgetCollection(store: VectorStore, profileId: string): void {
    ensuredCollections.get(store)?.delete(profileId);
  }

  async function profilesFor(store: VectorStore, row: OutboxRow): Promise<SyncProfile[]> {
    const all = await syncedProfiles();
    const chosen = row.profile_id ? all.filter((p) => p.profile_id === row.profile_id) : all;
    for (const profile of chosen) await ensureCollection(store, profile);
    return chosen;
  }

  /** D-07: a store without the tenant answers BackendNotReadyError(tenant_missing); create it once and retry in this slice. */
  async function upsert(store: VectorStore, profileId: string, tenantKey: string, plan: SyncPlan): Promise<void> {
    if (plan.upserts.length === 0) return;
    try {
      counts.upserted += await store.upsert(profileId, tenantKey, plan.upserts);
    } catch (error) {
      if (!isTenantMissing(error)) throw error;
      await store.ensureTenant(profileId, tenantKey);
      counts.upserted += await store.upsert(profileId, tenantKey, plan.upserts);
    }
  }

  /** A missing tenant holds no points, so there is nothing to list or delete. */
  async function listIds(store: VectorStore, profileId: string, tenantKey: string, documentId: string): Promise<string[]> {
    try {
      return await store.listDocumentIds(profileId, tenantKey, documentId);
    } catch (error) {
      if (isTenantMissing(error)) return [];
      throw error;
    }
  }

  async function remove(store: VectorStore, profileId: string, tenantKey: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      counts.deleted += await store.deleteIds(profileId, tenantKey, ids);
    } catch (error) {
      if (!isTenantMissing(error)) throw error;
    }
  }

  async function checkpoint(group: Group, cursor: string): Promise<void> {
    for (const row of group.rows) await checkpointRow(rpc, row.id, cursor);
    morePending = true;
  }

  function requireTenant(row: OutboxRow): string {
    if (!row.tenant_key || !isCanonicalTenantKey(row.tenant_key)) throw new DrainError('invalid_tenant_key');
    return row.tenant_key;
  }

  /** D-02: the whole document under the row's tenant, per synced profile, page by page; A-12 cursor `<profile>@<last chunk id>`. */
  async function syncDocument(store: VectorStore, group: Group): Promise<GroupOutcome> {
    const row = group.head;
    const tenantKey = requireTenant(row);
    const resume = parseDocumentCursor(groupCursor(group));
    const chosen = await profilesFor(store, row);
    const resumeIndex = resume ? chosen.findIndex((p) => p.profile_id === resume.profileId) : -1;
    for (let index = resumeIndex >= 0 ? resumeIndex : 0; index < chosen.length; index += 1) {
      const profile = chosen[index];
      let after: string | null = index === resumeIndex && resume ? resume.after : null;
      for (;;) {
        const rows = await readDocumentRows(rpc, { tenantKey, documentId: row.entity_id, profileId: profile.profile_id, after, limit: pageSize });
        const through = rows.length >= pageSize ? String(rows[rows.length - 1].chunk_id) : null;
        const storeIds = await listIds(store, profile.profile_id, tenantKey, row.entity_id);
        const plan = planDocumentSync(tenantKey, rows, storeIds, { after, through });
        await upsert(store, profile.profile_id, tenantKey, plan);
        await remove(store, profile.profile_id, tenantKey, plan.deletes);
        if (through === null) break;
        after = through;
        if (spent()) {
          await checkpoint(group, `${profile.profile_id}${CURSOR_SEPARATOR}${after}`);
          return 'checkpointed';
        }
      }
    }
    return 'done';
  }

  async function syncChunk(store: VectorStore, group: Group): Promise<GroupOutcome> {
    const row = group.head;
    const tenantKey = requireTenant(row);
    for (const profile of await profilesFor(store, row)) {
      const current = await readChunkRow(rpc, { tenantKey, chunkId: row.entity_id, profileId: profile.profile_id });
      const plan = planChunkSync(tenantKey, current, row.entity_id);
      await upsert(store, profile.profile_id, tenantKey, plan);
      await remove(store, profile.profile_id, tenantKey, plan.deletes);
    }
    return 'done';
  }

  /** Tenant and profile rows page through rag_vector_sync_expand into document rows; an empty tenant is removed from the store. */
  async function expand(store: VectorStore, group: Group): Promise<GroupOutcome> {
    const fresh = group.rows.find((row) => isFresh(row.cursor));
    const driver =
      fresh ?? [...group.rows].sort((a, b) => ((a.cursor ?? '') < (b.cursor ?? '') ? -1 : 1))[0];
    let first = true;
    for (;;) {
      const page = await expandRow(rpc, driver.id, pageSize);
      const empty = first && fresh !== undefined && isFresh(page.nextCursor) && !page.hasMore;
      first = false;
      if (empty && group.head.entity === 'tenant') {
        const tenantKey = requireTenant(group.head);
        for (const profile of await profilesFor(store, group.head)) {
          try {
            counts.deleted += await store.deleteTenant(profile.profile_id, tenantKey);
          } catch (error) {
            if (!isTenantMissing(error)) throw error;
          }
        }
      }
      if (!page.hasMore) return 'done';
      if (spent()) {
        await checkpoint(group, page.nextCursor ?? RESTART_CURSOR);
        return 'checkpointed';
      }
    }
  }

  async function processGroup(group: Group): Promise<GroupOutcome> {
    const store = stores.get(group.head.target);
    if (!store) throw new DrainError('target_unavailable');
    const row = group.head;
    if (row.profile_id && !(await syncedProfiles()).some((p) => p.profile_id === row.profile_id)) return 'done';
    try {
      if (row.entity === 'tenant' || row.entity === 'profile') return await expand(store, group);
      if (row.entity === 'document') return await syncDocument(store, group);
      if (row.entity === 'chunk') return await syncChunk(store, group);
      throw new DrainError('unknown_entity');
    } catch (error) {
      if (error instanceof BackendNotReadyError && error.reason === 'collection_missing') {
        for (const profile of await syncedProfiles()) forgetCollection(store, profile.profile_id);
      }
      throw error;
    }
  }

  async function failGroup(group: Group, error: unknown): Promise<void> {
    const code = codeOf(error);
    for (const row of group.rows) {
      const state = await failRow(rpc, row.id, code);
      counts.failed += 1;
      if (state === 'dead') counts.dead += 1;
    }
  }

  let stop = false;
  while (!stop) {
    if (spent()) {
      morePending = true;
      break;
    }
    const claimed = await claimBatch(rpc, { limit: batch, leaseSeconds });
    if (claimed.length === 0) {
      morePending = false;
      break;
    }
    counts.claimed += claimed.length;
    for (const row of claimed) {
      const lag = (now() - Date.parse(row.enqueued_at)) / 1000;
      if (Number.isFinite(lag) && lag > counts.lagSeconds) counts.lagSeconds = lag;
    }
    const done: Array<number | string> = [];
    for (const group of coalesce(claimed)) {
      if (stop || spent()) {
        // Not started: hand the rows back at their own position without counting the attempt.
        stop = true;
        await checkpoint(group, groupCursor(group) ?? RESTART_CURSOR);
        continue;
      }
      try {
        const outcome = await processGroup(group);
        if (outcome === 'done') done.push(...group.rows.map((row) => row.id));
      } catch (error) {
        await failGroup(group, error);
      }
    }
    await completeRows(rpc, done);
  }

  const report = VectorSyncSliceReportSchema.parse({
    mode: 'drain',
    claimed: counts.claimed,
    upserted: counts.upserted,
    deleted: counts.deleted,
    failed: counts.failed,
    dead: counts.dead,
    lag_seconds: Math.max(0, Number(counts.lagSeconds.toFixed(3))),
    elapsed_ms: Math.max(0, Math.round(now() - started)),
    budget_ms: Math.max(0, Math.round(budgetMs)),
    more_pending: morePending,
  });
  (options.sink ?? ((line: string) => console.log(line)))(
    `[Vector Sync] ${JSON.stringify({ mode: report.mode, claimed: report.claimed, upserted: report.upserted, deleted: report.deleted, failed: report.failed, dead: report.dead, lagSeconds: report.lag_seconds, elapsedMs: report.elapsed_ms })}`,
  );
  return report;
}

/** The CLI and backfill path (D-04 c): slices until nothing is claimable; each slice keeps its own budget and log line. */
export async function drainUntilEmpty(options: DrainUntilEmptyOptions): Promise<VectorSyncSliceReport[]> {
  const reports: VectorSyncSliceReport[] = [];
  const maxSlices = options.maxSlices ?? DEFAULT_MAX_SLICES;
  for (let i = 0; i < maxSlices; i += 1) {
    const report = await drainSlice(options);
    reports.push(report);
    if (!report.more_pending) break;
  }
  return reports;
}
