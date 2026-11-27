import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { scopeKey, type TenantScope } from '../tenant/scope';

/**
 * D-26, P-28: the scope gate's per-tenant centroid set, cached in process (LRU, 60 s) and stale-while-revalidate. The request path
 * never waits for the database: a miss answers null (the gate is then unsure) and starts one background refresh; an expired entry is
 * served while one refresh runs. The cache key is the tenant key plus the embedding profile id (T-06.2-51).
 */
export const SCOPE_CENTROID_CACHE_TTL_MS = 60_000;
export const SCOPE_CENTROID_CACHE_MAX = 256;
/** A failed refresh is not retried sooner than this, so a broken backend is not read on every request. */
export const SCOPE_CENTROID_RETRY_MS = 5_000;
export const SCOPE_CENTROID_LOAD_TIMEOUT_MS = 5_000;
/** Scoring stays within the 06.2-21 benchmark: at most 200 centroids (largest groups first) and 100 examples per snapshot. */
export const MAX_SNAPSHOT_CENTROIDS = 200;
export const MAX_SNAPSHOT_EXAMPLES = 100;

export type ScopeGroupKind = 'doc_type' | 'scope_tag' | 'tenant';

const KINDS: readonly string[] = ['doc_type', 'scope_tag', 'tenant'];

export interface ScopeCentroid {
  kind: ScopeGroupKind;
  key: string;
  memberCount: number;
  /** Unit-normalized. */
  vector: Float32Array;
}

export interface CentroidSnapshot {
  tenantKey: string;
  profileId: string;
  /** 0 when the tenant has no centroids for the profile. */
  dims: number;
  centroids: readonly ScopeCentroid[];
  /** Unit-normalized out-of-scope example vectors; the text is never kept. */
  examples: readonly Float32Array[];
  /** D-38, P-13: the tenant has an active doc-type-scoped embedding binding, so the gate stays unsure for it. */
  unsupported: boolean;
  loadedAt: number;
}

interface Entry {
  snapshot: CentroidSnapshot | null;
  loadedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const failedAt = new Map<string, number>();
const generations = new Map<string, number>();
const loggedProblems = new Set<string>();

function problem(key: string, message: string, data: Record<string, unknown> = {}): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Scope Gate] ${message}`, data);
}

function cacheKey(tenantKey: string, profileId: string): string {
  return `${tenantKey}|${profileId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A halfvec or vector value as PostgREST answers it ("[1,2,3]") or as an array; null when malformed. */
export function parseVectorValue(value: unknown): number[] | null {
  let values: unknown[];
  if (Array.isArray(value)) values = value;
  else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    const body = trimmed.slice(1, -1).trim();
    if (body === '') return null;
    values = body.split(',').map((part) => Number(part));
  } else return null;
  const out: number[] = [];
  for (const item of values) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return out.length > 0 ? out : null;
}

/** Unit-normalizes into a Float32Array; null for a zero or non-finite vector. */
export function unitVector(values: readonly number[]): Float32Array | null {
  let sum = 0;
  for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return null;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = (values[i] as number) / norm;
  return out;
}

class LoadFailure extends Error {
  readonly code: string;

  constructor(rpc: string, code: string) {
    super(`${rpc} failed`);
    this.name = 'ScopeCentroidLoadFailure';
    this.code = `${rpc}:${code}`;
  }
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]> {
  const { data, error } = await client.rpc(fn, args).abortSignal(signal);
  if (error) throw new LoadFailure(fn, error.code ?? 'unknown');
  return rpcRows(data);
}

function mapCentroids(rows: unknown[]): { centroids: ScopeCentroid[]; dims: number } {
  const parsed: ScopeCentroid[] = [];
  let dims = 0;
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row) continue;
    const kind = row.group_kind;
    const key = row.group_key;
    if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof key !== 'string') continue;
    const values = parseVectorValue(row.centroid);
    if (!values || (typeof row.dims === 'number' && values.length !== row.dims)) continue;
    if (dims === 0) dims = values.length;
    if (values.length !== dims) continue;
    const vector = unitVector(values);
    if (!vector) continue;
    const memberCount = typeof row.member_count === 'number' ? row.member_count : Number(row.member_count ?? 0);
    parsed.push({ kind: kind as ScopeGroupKind, key, memberCount: Number.isFinite(memberCount) ? memberCount : 0, vector });
  }
  parsed.sort((a, b) => b.memberCount - a.memberCount || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { centroids: parsed.slice(0, MAX_SNAPSHOT_CENTROIDS), dims };
}

function mapExamples(rows: unknown[], dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (const raw of rows) {
    if (out.length >= MAX_SNAPSHOT_EXAMPLES) break;
    const row = asRecord(raw);
    if (!row) continue;
    const values = parseVectorValue(row.embedding);
    if (!values || (dims > 0 && values.length !== dims)) continue;
    const vector = unitVector(values);
    if (vector) out.push(vector);
  }
  return out;
}

async function load(client: RpcClient, tenantKey: string, profileId: string): Promise<CentroidSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCOPE_CENTROID_LOAD_TIMEOUT_MS);
  try {
    const args = { p_tenant_key: tenantKey, p_profile_id: profileId };
    const [centroidRows, exampleRows, statusRows] = await Promise.all([
      call(client, 'rag_scope_centroids_list', args, controller.signal),
      call(client, 'rag_scope_examples_list', args, controller.signal),
      call(client, 'rag_scope_status', args, controller.signal),
    ]);
    const { centroids, dims } = mapCentroids(centroidRows);
    const status = asRecord(statusRows[0]);
    return {
      tenantKey,
      profileId,
      dims,
      centroids,
      examples: mapExamples(exampleRows, dims),
      unsupported: status?.has_scoped_binding === true,
      loadedAt: getRagDeps().now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function store(key: string, entry: Entry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > SCOPE_CENTROID_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function startRefresh(tenantKey: string, profileId: string): Promise<void> | null {
  const key = cacheKey(tenantKey, profileId);
  const running = inflight.get(key);
  if (running) return running;
  const now = getRagDeps().now();
  const failed = failedAt.get(key);
  if (failed !== undefined && now - failed >= 0 && now - failed < SCOPE_CENTROID_RETRY_MS) return null;
  const admin = getRagDeps().adminClient() as unknown as RpcClient | null;
  if (!admin) {
    failedAt.set(key, now);
    problem('admin_unavailable', 'centroid_load_skipped code=admin_unavailable');
    return null;
  }
  const generation = generations.get(tenantKey) ?? 0;
  const run = load(admin, tenantKey, profileId)
    .then((snapshot) => {
      if ((generations.get(tenantKey) ?? 0) !== generation) return;
      failedAt.delete(key);
      store(key, { snapshot, loadedAt: snapshot.loadedAt });
    })
    .catch((error: unknown) => {
      failedAt.set(key, getRagDeps().now());
      const code = error instanceof LoadFailure ? error.code : error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'unknown';
      problem(`load:${code}`, `centroid_load_failed code=${code}`);
    })
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

/**
 * The cached snapshot for the scope's tenant and an embedding profile, or null when none is loaded yet. Never awaits I/O and never
 * throws: a miss or an expired entry starts one background refresh, a failed refresh keeps the previous snapshot.
 */
export function getCentroidSnapshot(scope: TenantScope, profileId: string): CentroidSnapshot | null {
  try {
    const tenantKey = scopeKey(scope);
    const key = cacheKey(tenantKey, profileId);
    const entry = cache.get(key);
    if (!entry) {
      void startRefresh(tenantKey, profileId);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    const age = getRagDeps().now() - entry.loadedAt;
    if (age < 0 || age >= SCOPE_CENTROID_CACHE_TTL_MS) void startRefresh(tenantKey, profileId);
    return entry.snapshot;
  } catch {
    problem('snapshot_failed', 'centroid_snapshot_failed code=unknown');
    return null;
  }
}

/** Reads the snapshot now and waits for it (admin views, tests); null when the read fails. Never used on the request path. */
export async function refreshCentroidSnapshot(scope: TenantScope, profileId: string): Promise<CentroidSnapshot | null> {
  const tenantKey = scopeKey(scope);
  const key = cacheKey(tenantKey, profileId);
  failedAt.delete(key);
  await startRefresh(tenantKey, profileId);
  return cache.get(key)?.snapshot ?? null;
}

/** Drops every cached profile of the scope's tenant; a refresh already running for it is discarded. */
export function invalidateCentroidCache(scope: TenantScope): void {
  invalidateCentroidCacheForKey(scopeKey(scope));
}

/** Internal: the hook and the build service hold a canonical tenant key from the publish event or the scope. */
export function invalidateCentroidCacheForKey(tenantKey: string): void {
  generations.set(tenantKey, (generations.get(tenantKey) ?? 0) + 1);
  const prefix = `${tenantKey}|`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  for (const key of [...inflight.keys()]) if (key.startsWith(prefix)) inflight.delete(key);
  for (const key of [...failedAt.keys()]) if (key.startsWith(prefix)) failedAt.delete(key);
}

/** Tests only: resolves once every background refresh started so far has finished. */
export async function centroidRefreshesSettledForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
}

export function resetCentroidCacheForTests(): void {
  cache.clear();
  inflight.clear();
  failedAt.clear();
  generations.clear();
  loggedProblems.clear();
}
