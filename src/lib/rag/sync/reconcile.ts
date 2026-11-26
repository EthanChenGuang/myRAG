import { createHash } from 'node:crypto';
import { BackendNotReadyError } from '@/lib/rag/backend/external';
import { RetrievalBackendError, rpcRows, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import {
  ReconcileReportSchema,
  VectorSyncSliceReportSchema,
  type ReconcileReport,
  type VectorSyncSliceReport,
} from '@/lib/rag-eval/contracts.generated';
import { readSyncProfiles, type SyncProfile } from './claim';
import { logVectorSync, type VectorSyncLogSink } from './log';
import type { StoreScanPoint, VectorStore } from './stores/types';
import { traceVectorSync, type VectorSyncTraceOptions } from './trace';

export const RECONCILE_BUCKETS = 64;
export const RECONCILE_PRUNE_DAYS = 7;
export const RECONCILE_DEFAULT_BUDGET_MS = 45_000;
export const RECONCILE_PAGE = 500;
const ZERO = BigInt(0);
const ERROR_CODE_RE = /^[a-z0-9_.:-]{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The 0707 hash definition: m = md5 of the lowercase chunk id. Kept byte for byte equal to the SQL. */
function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function signed64(hex: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`));
}

function normalizeId(id: string): string {
  return id.toLowerCase();
}

/** First md5 byte mod 64. */
export function bucketOf(id: string): number {
  return parseInt(md5(normalizeId(id)).slice(0, 2), 16) % RECONCILE_BUCKETS;
}

/** First 16 hex digits of md5(id) as a signed 64-bit integer. */
export function idHash64(id: string): bigint {
  return signed64(md5(normalizeId(id)));
}

/** The per-row content digest over (id, content_hash, lexical_version); a null field hashes as the empty string. */
export function contentHash64(id: string, contentHash: string | null, lexicalVersion: number | null): bigint {
  return signed64(md5(`${normalizeId(id)}:${contentHash ?? ''}:${lexicalVersion === null ? '' : String(lexicalVersion)}`));
}

export interface ReconcileSliceOptions {
  /** One store per enabled target. A target without a store is not reconciled. */
  stores: VectorStore[];
  rpc: RpcClient;
  budgetMs?: number;
  pageSize?: number;
  now?: () => number;
  sink?: VectorSyncLogSink;
  /** Langfuse options for the per-slice trace; false turns it off. Default: the environment's Langfuse config. */
  trace?: VectorSyncTraceOptions | false;
}

export interface ReconcileSliceResult {
  slice: VectorSyncSliceReport;
  reports: ReconcileReport[];
  pruned: number;
}

interface Aggregate {
  count: number[];
  idXor: bigint[];
  contentXor: bigint[];
}

interface Candidate {
  store: VectorStore;
  profile: SyncProfile;
  tenantKey: string;
  last: number | null;
}

interface SupabaseRow {
  chunk_id: string;
  document_id: string;
  content_hash: string | null;
  lexical_version: number | null;
}

class ReconcileError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`[Vector Sync] ${code}`);
    this.code = code;
  }
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown[]> {
  const response = await rpc.rpc(fn, args).abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError(fn, response.error.code ?? null);
  return rpcRows(response.data);
}

function emptyAggregate(): Aggregate {
  return {
    count: new Array<number>(RECONCILE_BUCKETS).fill(0),
    idXor: new Array<bigint>(RECONCILE_BUCKETS).fill(ZERO),
    contentXor: new Array<bigint>(RECONCILE_BUCKETS).fill(ZERO),
  };
}

function total(aggregate: Aggregate): number {
  return aggregate.count.reduce((sum, n) => sum + n, 0);
}

function codeOf(error: unknown): string {
  let code = 'store_error';
  if (error instanceof ReconcileError) code = error.code;
  else if (error instanceof RetrievalBackendError) code = `${error.rpc}:${error.code ?? 'rpc_error'}`.toLowerCase();
  else if (error instanceof BackendNotReadyError) code = `backend_not_ready:${error.reason}`;
  return ERROR_CODE_RE.test(code) ? code : 'reconcile_error';
}

/** A store without the collection or the tenant holds no points for it. */
function isAbsent(error: unknown): boolean {
  return error instanceof BackendNotReadyError && (error.reason === 'tenant_missing' || error.reason === 'collection_missing');
}

async function readSummary(rpc: RpcClient, tenantKey: string, profileId: string): Promise<Aggregate> {
  const rows = (await call(rpc, 'rag_vector_sync_reconcile_summary', { p_tenant_key: tenantKey, p_profile_id: profileId })) as Array<{
    bucket: number;
    row_count: number | string;
    id_xor: string;
    content_xor: string;
  }>;
  const aggregate = emptyAggregate();
  for (const row of rows) {
    const bucket = Number(row.bucket);
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= RECONCILE_BUCKETS) throw new ReconcileError('summary_invalid');
    aggregate.count[bucket] = Number(row.row_count);
    aggregate.idXor[bucket] = BigInt(row.id_xor);
    aggregate.contentXor[bucket] = BigInt(row.content_xor);
  }
  return aggregate;
}

async function readBucket(rpc: RpcClient, tenantKey: string, profileId: string, bucket: number, pageSize: number): Promise<SupabaseRow[]> {
  const out: SupabaseRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page = (await call(rpc, 'rag_vector_sync_bucket_rows', {
      p_tenant_key: tenantKey,
      p_profile_id: profileId,
      p_bucket: bucket,
      p_after: after,
      p_limit: pageSize,
    })) as SupabaseRow[];
    out.push(...page);
    if (page.length < pageSize) return out;
    after = String(page[page.length - 1].chunk_id);
  }
}

/** Pages every point of one tenant partition; `visit` sees each point once. */
async function scanStore(store: VectorStore, profileId: string, tenantKey: string, pageSize: number, visit: (point: StoreScanPoint) => void): Promise<void> {
  let after: string | null = null;
  try {
    for (;;) {
      const page = await store.scanTenant(profileId, tenantKey, { after, limit: pageSize });
      for (const point of page.points) visit(point);
      if (page.next === null || page.points.length === 0) return;
      after = page.next;
    }
  } catch (error) {
    if (isAbsent(error)) return;
    throw error;
  }
}

async function enqueueRepair(
  rpc: RpcClient,
  args: { target: string; entity: 'chunk' | 'document' | 'tenant'; entityId: string; tenantKey: string; profileId: string },
): Promise<number> {
  const [n] = await call(rpc, 'rag_vector_sync_enqueue_repair', {
    p_target: args.target,
    p_entity: args.entity,
    p_entity_id: args.entityId,
    p_tenant_key: args.tenantKey,
    p_profile_id: args.profileId,
  });
  return Number(n ?? 0);
}

async function setState(
  rpc: RpcClient,
  args: { target: string; profileId: string; tenantKey: string; state: 'ready' | 'stale' | 'failed'; supabaseCount: number | null; backendCount: number | null; error: string | null },
): Promise<ReconcileReport['state']> {
  const [state] = await call(rpc, 'rag_set_backend_index_state', {
    p_target: args.target,
    p_profile_id: args.profileId,
    p_tenant_key: args.tenantKey,
    p_state: args.state,
    p_supabase_count: args.supabaseCount,
    p_backend_count: args.backendCount,
    p_error: args.error,
  });
  return state === 'building' || state === 'ready' || state === 'stale' || state === 'failed' ? state : args.state;
}

/**
 * One (target, profile, tenant) compare (D-05): count, 64 bucketed id XORs and 64 bucketed content digests on both sides. Only
 * mismatched buckets are listed id by id. Missing and stale ids re-sync their documents, extra ids get a `chunk` row the drain
 * deletes, a tenant with points and no servable rows gets a `tenant` row. State is ready only when every bucket matches.
 */
async function reconcileOne(rpc: RpcClient, candidate: Candidate, pageSize: number): Promise<ReconcileReport> {
  const { store, profile, tenantKey } = candidate;
  const target = store.target;
  const profileId = profile.profile_id;
  let supabaseCount = 0;
  let backendCount = 0;
  try {
    const supabase = await readSummary(rpc, tenantKey, profileId);
    supabaseCount = total(supabase);

    const backend = emptyAggregate();
    await scanStore(store, profileId, tenantKey, pageSize, (point) => {
      const id = normalizeId(point.id);
      const bucket = bucketOf(id);
      backend.count[bucket] += 1;
      backend.idXor[bucket] ^= idHash64(id);
      backend.contentXor[bucket] ^= contentHash64(id, point.contentHash, point.lexicalVersion ?? null);
    });
    backendCount = total(backend);

    const mismatched: number[] = [];
    for (let b = 0; b < RECONCILE_BUCKETS; b += 1) {
      if (supabase.count[b] !== backend.count[b] || supabase.idXor[b] !== backend.idXor[b] || supabase.contentXor[b] !== backend.contentXor[b]) {
        mismatched.push(b);
      }
    }

    let missing = 0;
    let extra = 0;
    let stale = 0;
    let repairs = 0;
    if (mismatched.length > 0) {
      const wanted = new Set(mismatched);
      const storePoints = new Map<string, StoreScanPoint>();
      await scanStore(store, profileId, tenantKey, pageSize, (point) => {
        const id = normalizeId(point.id);
        if (wanted.has(bucketOf(id))) storePoints.set(id, point);
      });
      const documents = new Set<string>();
      const extras: string[] = [];
      for (const bucket of mismatched) {
        const rows = await readBucket(rpc, tenantKey, profileId, bucket, pageSize);
        const seen = new Set<string>();
        for (const row of rows) {
          const id = normalizeId(String(row.chunk_id));
          seen.add(id);
          const point = storePoints.get(id);
          if (!point) {
            missing += 1;
            documents.add(String(row.document_id));
          } else if (point.contentHash !== row.content_hash || (point.lexicalVersion ?? null) !== row.lexical_version) {
            stale += 1;
            documents.add(String(row.document_id));
          }
        }
        for (const id of storePoints.keys()) {
          if (bucketOf(id) === bucket && !seen.has(id)) {
            extra += 1;
            extras.push(id);
          }
        }
      }
      for (const documentId of [...documents].sort()) {
        repairs += await enqueueRepair(rpc, { target, entity: 'document', entityId: documentId, tenantKey, profileId });
      }
      // An id that is not a UUID cannot be a chunk; the drain cannot name it, so it is counted and left to re-validation (D-10).
      for (const id of extras.sort()) {
        if (UUID_RE.test(id)) repairs += await enqueueRepair(rpc, { target, entity: 'chunk', entityId: id, tenantKey, profileId });
      }
      if (supabaseCount === 0 && backendCount > 0) {
        repairs += await enqueueRepair(rpc, { target, entity: 'tenant', entityId: tenantKey, tenantKey, profileId });
      }
    }

    const state = await setState(rpc, {
      target,
      profileId,
      tenantKey,
      state: mismatched.length === 0 ? 'ready' : 'stale',
      supabaseCount,
      backendCount,
      error: null,
    });
    return ReconcileReportSchema.parse({
      target,
      profile_id: profileId,
      tenant_key: tenantKey,
      supabase_count: supabaseCount,
      backend_count: backendCount,
      mismatched_buckets: mismatched.length,
      missing,
      extra,
      stale,
      repairs_enqueued: repairs,
      state,
    });
  } catch (error) {
    const code = codeOf(error);
    try {
      await setState(rpc, { target, profileId, tenantKey, state: 'failed', supabaseCount, backendCount, error: code });
    } catch {
      // The state write failing too leaves the previous state; the report still says failed.
    }
    return ReconcileReportSchema.parse({
      target,
      profile_id: profileId,
      tenant_key: tenantKey,
      supabase_count: supabaseCount,
      backend_count: backendCount,
      mismatched_buckets: 0,
      missing: 0,
      extra: 0,
      stale: 0,
      repairs_enqueued: 0,
      state: 'failed',
    });
  }
}

function byLeastRecent(a: Candidate, b: Candidate): number {
  if (a.last !== b.last) {
    if (a.last === null) return -1;
    if (b.last === null) return 1;
    return a.last - b.last;
  }
  const ka = `${a.store.target}|${a.profile.profile_id}|${a.tenantKey}`;
  const kb = `${b.store.target}|${b.profile.profile_id}|${b.tenantKey}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * One time-sliced reconcile run (D-05, D-11, A-12): prunes done outbox rows older than 7 days, then compares the least recently
 * reconciled (target, profile, tenant) first until the budget is spent. A compare in progress always finishes.
 */
export async function reconcileSlice(options: ReconcileSliceOptions): Promise<ReconcileSliceResult> {
  const { rpc } = options;
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? RECONCILE_DEFAULT_BUDGET_MS;
  const pageSize = options.pageSize ?? RECONCILE_PAGE;
  const started = now();
  const spent = (): boolean => now() - started >= budgetMs;

  const stores = new Map<string, VectorStore>();
  for (const store of options.stores) stores.set(store.target, store);

  const [prunedRaw] = await call(rpc, 'rag_vector_sync_prune', { p_days: RECONCILE_PRUNE_DAYS });
  const pruned = Number(prunedRaw ?? 0);

  const profiles = [...(await readSyncProfiles(rpc))].sort((a, b) => (a.profile_id < b.profile_id ? -1 : 1));
  const candidates: Candidate[] = [];
  for (const store of stores.values()) {
    for (const profile of profiles) {
      const rows = (await call(rpc, 'rag_vector_sync_tenants', { p_target: store.target, p_profile_id: profile.profile_id })) as Array<{
        tenant_key: string;
        last_reconciled_at: string | null;
      }>;
      for (const row of rows) {
        const last = row.last_reconciled_at === null ? null : Date.parse(row.last_reconciled_at);
        candidates.push({ store, profile, tenantKey: row.tenant_key, last: last !== null && Number.isFinite(last) ? last : null });
      }
    }
  }
  candidates.sort(byLeastRecent);

  const reports: ReconcileReport[] = [];
  let morePending = false;
  for (let i = 0; i < candidates.length; i += 1) {
    if (spent()) {
      morePending = true;
      break;
    }
    reports.push(await reconcileOne(rpc, candidates[i], pageSize));
  }

  const slice = VectorSyncSliceReportSchema.parse({
    mode: 'reconcile',
    claimed: reports.length,
    upserted: 0,
    deleted: 0,
    failed: reports.filter((r) => r.state === 'failed').length,
    dead: 0,
    lag_seconds: 0,
    elapsed_ms: Math.max(0, Math.round(now() - started)),
    budget_ms: Math.max(0, Math.round(budgetMs)),
    more_pending: morePending,
  });
  logVectorSync(slice, options.sink);
  if (options.trace !== false) traceVectorSync(slice, options.trace ?? {});
  return { slice, reports, pruned };
}
