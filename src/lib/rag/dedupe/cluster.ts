import { DupClusterParamsSchema } from '@/lib/rag-eval/contracts.generated';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { getIngestDeps } from '../ingest/deps';
import { isTenantKey } from '../ingest/writer';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { simhash64, toInt64String } from './simhash';

/** D-49: the shipped threshold; a fixture-fitted value reaches the service only as an explicit option (eval tooling). */
export const DUP_CLUSTER_THRESHOLD_DEFAULT: number = DupClusterParamsSchema.parse({}).threshold;
/** Candidates need at most this many differing SimHash bits before the cosine check. */
export const DUP_CLUSTER_MAX_HAMMING = 16;
/** Candidates returned per source chunk. */
export const DUP_CLUSTER_CANDIDATE_LIMIT = 50;

const BATCH = 500;
const RPC_ARRAY_CAP = 1000;
const LIST_LIMIT = 1000;

export class DupClusterError extends Error {
  readonly code: string;
  /** The failing RPC's error code (SQLSTATE or PostgREST code), when there is one. */
  readonly rpcCode: string | null;

  constructor(code: string, rpcCode: string | null = null) {
    super(`[RAG Dedupe] ${code}${rpcCode ? ` (${rpcCode})` : ''}`);
    this.name = 'DupClusterError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

export interface ClusterOptions {
  db?: RpcClient | null;
  signal?: AbortSignal;
  threshold?: number;
  maxHamming?: number;
  /** false: cluster from the stored hashes without hashing the chunks again. */
  rehash?: boolean;
  /** The embedding profile of the chunks; resolved from the active profile when a per-profile threshold exists. */
  embeddingProfileId?: string | null;
  /** Eval harness only: a fixture-fitted threshold applies. Production callers never set it. */
  evalRun?: boolean;
}

export interface ClusterReport {
  /** Chunks whose SimHash and bands were written. */
  hashed: number;
  /** Chunks of the input that belong to a cluster afterwards. */
  clustered: number;
  /** Distinct clusters the run assigned chunks to. */
  clusters: number;
}

export interface RecomputeReport {
  recomputed: number;
  dissolved: number;
}

export type RecomputeOutcome = ({ ok: true; skipped: false } & RecomputeReport) | { ok: true; skipped: true } | { ok: false; error: string };

type Row = Record<string, unknown>;

interface ChunkText {
  id: string;
  content: string;
}

interface Candidate {
  chunkId: string;
  candidateId: string;
  candidateClusterId: string | null;
  similarity: number | null;
  exact: boolean;
}

function resolveDb(options: { db?: RpcClient | null }): RpcClient {
  const db = options.db === undefined ? getIngestDeps().db() : options.db;
  if (!db) throw new DupClusterError('unavailable');
  return db;
}

async function callRpc(db: RpcClient, signal: AbortSignal, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new DupClusterError(`rpc_failed:${rpc}`, response.error.code ?? null);
  return rpcRows(response.data) as Row[];
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : value === null || value === undefined ? null : String(value);
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function checkThreshold(value: number | undefined): number {
  const threshold = value ?? DUP_CLUSTER_THRESHOLD_DEFAULT;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new DupClusterError('invalid_threshold');
  return threshold;
}

function checkHamming(value: number | undefined): number {
  const max = value ?? DUP_CLUSTER_MAX_HAMMING;
  if (!Number.isInteger(max) || max < 0 || max > 64) throw new DupClusterError('invalid_max_hamming');
  return max;
}

/** Keyset page of chunk text; the content is used for hashing only and never logged. */
export async function listChunkText(
  db: RpcClient,
  tenantKey: string,
  input: { after?: string | null; limit?: number; documentId?: string | null; chunkIds?: string[] | null },
  signal: AbortSignal,
): Promise<{ id: string; documentId: string; content: string }[]> {
  const rows = await callRpc(db, signal, 'rag_dup_backfill_candidates', {
    p_tenant_key: tenantKey,
    p_after: input.after ?? null,
    p_limit: input.limit ?? LIST_LIMIT,
    p_document_id: input.documentId ?? null,
    p_chunk_ids: input.chunkIds ?? null,
  });
  return rows.map((row) => ({ id: String(row.id), documentId: String(row.document_id), content: typeof row.content === 'string' ? row.content : '' }));
}

async function writeHashes(db: RpcClient, tenantKey: string, chunks: ChunkText[], signal: AbortSignal): Promise<number> {
  let written = 0;
  for (const batch of chunked(chunks, RPC_ARRAY_CAP)) {
    const rows = await callRpc(db, signal, 'rag_dup_write_hashes', {
      p_tenant_key: tenantKey,
      p_rows: batch.map((chunk) => ({ id: chunk.id, simhash: toInt64String(simhash64(chunk.content)) })),
    });
    written += Number(rows[0]?.written ?? 0);
  }
  return written;
}

async function listCandidates(
  db: RpcClient,
  tenantKey: string,
  chunkIds: string[],
  settings: { threshold: number; maxHamming: number },
  signal: AbortSignal,
): Promise<Candidate[]> {
  const rows = await callRpc(db, signal, 'rag_dup_candidates', {
    p_tenant_key: tenantKey,
    p_chunk_ids: chunkIds,
    p_max_hamming: settings.maxHamming,
    p_threshold: settings.threshold,
    p_limit: DUP_CLUSTER_CANDIDATE_LIMIT,
  });
  return rows.map((row) => ({
    chunkId: String(row.chunk_id),
    candidateId: String(row.candidate_id),
    candidateClusterId: text(row.candidate_cluster_id),
    similarity: row.similarity === null || row.similarity === undefined ? null : Number(row.similarity),
    exact: row.exact === true,
  }));
}

/** Better first: an exact duplicate, then the higher cosine. */
function better(a: Candidate, b: Candidate): boolean {
  if (a.exact !== b.exact) return a.exact;
  return (a.similarity ?? -2) > (b.similarity ?? -2);
}

interface Group {
  chunkIds: Set<string>;
  preferred: Candidate | null;
}

/**
 * Connected groups of the accepted pairs. A candidate already in a cluster is represented by one chunk per cluster, which brings the
 * whole cluster in (rag_dup_assign merges clusters); the preferred cluster is the one of the group's best candidate.
 */
function groupsOf(candidates: Candidate[]): Group[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let node = id;
    while (node !== root) {
      const next = parent.get(node) as string;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const add = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const clusterChunk = new Map<string, string>();
  const nodeOf = (candidate: Candidate): string => {
    if (!candidate.candidateClusterId) return candidate.candidateId;
    const existing = clusterChunk.get(candidate.candidateClusterId);
    if (existing) return existing;
    clusterChunk.set(candidate.candidateClusterId, candidate.candidateId);
    return candidate.candidateId;
  };
  for (const candidate of candidates) {
    const other = nodeOf(candidate);
    add(candidate.chunkId);
    add(other);
    const a = find(candidate.chunkId);
    const b = find(other);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, Group>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = groups.get(root) ?? { chunkIds: new Set<string>(), preferred: null };
    group.chunkIds.add(id);
    groups.set(root, group);
  }
  for (const candidate of candidates) {
    if (!candidate.candidateClusterId) continue;
    const group = groups.get(find(candidate.chunkId)) as Group;
    if (!group.preferred || better(candidate, group.preferred)) group.preferred = candidate;
  }
  return [...groups.values()];
}

async function assignGroup(db: RpcClient, tenantKey: string, group: Group, signal: AbortSignal): Promise<string | null> {
  let preferred = group.preferred?.candidateClusterId ?? null;
  for (const batch of chunked([...group.chunkIds].sort(), RPC_ARRAY_CAP)) {
    const rows = await callRpc(db, signal, 'rag_dup_assign', { p_tenant_key: tenantKey, p_chunk_ids: batch, p_preferred_cluster_id: preferred });
    preferred = text(rows[0]?.cluster_id) ?? preferred;
  }
  return preferred;
}

/** Tenant-key form for the operator backfill; every other caller goes through a verified TenantScope. */
export async function clusterChunksForTenantKey(
  tenantKey: string,
  chunks: ChunkText[],
  options: ClusterOptions & { db: RpcClient },
): Promise<ClusterReport> {
  if (!isTenantKey(tenantKey)) throw new DupClusterError('invalid_tenant_key');
  const signal = options.signal ?? new AbortController().signal;
  const settings = { threshold: checkThreshold(options.threshold), maxHamming: checkHamming(options.maxHamming) };
  const db = options.db;
  let hashed = 0;
  const clusterIds = new Set<string>();
  const clustered = new Set<string>();
  for (const batch of chunked(chunks, BATCH)) {
    if (options.rehash !== false) hashed += await writeHashes(db, tenantKey, batch, signal);
    const ids = batch.map((chunk) => chunk.id);
    const candidates = await listCandidates(db, tenantKey, ids, settings, signal);
    for (const group of groupsOf(candidates)) {
      const clusterId = await assignGroup(db, tenantKey, group, signal);
      if (!clusterId) continue;
      clusterIds.add(clusterId);
      for (const id of group.chunkIds) if (ids.includes(id)) clustered.add(id);
    }
  }
  return { hashed, clustered: clustered.size, clusters: clusterIds.size };
}

/** D-19: hashes the chunks (current, ready ones of the tenant) and puts each near or exact duplicate into a cluster. */
export async function clusterChunks(scope: TenantScope, chunkIds: string[], options: ClusterOptions = {}): Promise<ClusterReport> {
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope).toLowerCase();
  const db = resolveDb(options);
  const signal = options.signal ?? new AbortController().signal;
  const unique = [...new Set(chunkIds)];
  const chunks: ChunkText[] = [];
  for (const batch of chunked(unique, RPC_ARRAY_CAP)) {
    chunks.push(...(await listChunkText(db, tenantKey, { chunkIds: batch }, signal)));
  }
  return clusterChunksForTenantKey(tenantKey, chunks, { ...options, db, signal });
}

/** Recompute for the operator backfill; throws DupClusterError. */
export async function recomputeForTenantKey(tenantKey: string, options: { db: RpcClient; signal?: AbortSignal; clusterIds?: string[] | null }): Promise<RecomputeReport> {
  if (!isTenantKey(tenantKey)) throw new DupClusterError('invalid_tenant_key');
  const signal = options.signal ?? new AbortController().signal;
  const rows = await callRpc(options.db, signal, 'rag_dup_clusters_recompute', { p_tenant_key: tenantKey, p_cluster_ids: options.clusterIds ?? null });
  return { recomputed: Number(rows[0]?.recomputed ?? 0), dissolved: Number(rows[0]?.dissolved ?? 0) };
}

/** RAG_DUP_CLUSTERS as the running process has it (the typed RAG configuration). */
export async function dupClustersEnabled(): Promise<boolean> {
  const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../config'), import('../deps')]);
  return loadRagConfig(getRagDeps().ragEnv()).v2.dupClusters;
}

/**
 * D-19: the publish sub-step. Hashes and clusters the new version's chunks, then recomputes the tenant's dirty clusters (the 0853
 * triggers marked those of a superseded version). Throws DupClusterError; the caller treats a failure as non-fatal.
 */
export async function clusterPublishedDocument(
  scope: TenantScope,
  documentId: string,
  options: ClusterOptions = {},
): Promise<ClusterReport & RecomputeReport> {
  assertTenantScope(scope);
  const tenantKey = scopeKey(scope).toLowerCase();
  const db = resolveDb(options);
  const signal = options.signal ?? new AbortController().signal;
  const chunks: ChunkText[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await listChunkText(db, tenantKey, { after, documentId }, signal);
    chunks.push(...page);
    if (page.length < LIST_LIMIT) break;
    after = page[page.length - 1]?.id ?? null;
  }
  const report = chunks.length > 0 ? await clusterChunksForTenantKey(tenantKey, chunks, { ...options, db, signal }) : { hashed: 0, clustered: 0, clusters: 0 };
  const recompute = await recomputeForTenantKey(tenantKey, { db, signal });
  return { ...report, ...recompute };
}

/**
 * D-20: refreshes the tenant's dirty clusters after a delete or supersede. Switch-gated (RAG_DUP_CLUSTERS) and non-fatal: a failure is
 * logged with the error name only and the backfill repairs it later.
 */
export async function recomputeDirtyDupClusters(
  scope: TenantScope,
  options: { db?: RpcClient | null; signal?: AbortSignal; enabled?: boolean } = {},
): Promise<RecomputeOutcome> {
  try {
    assertTenantScope(scope);
    if (!(options.enabled ?? (await dupClustersEnabled()))) return { ok: true, skipped: true };
    const db = resolveDb(options);
    const report = await recomputeForTenantKey(scopeKey(scope).toLowerCase(), { db, ...(options.signal ? { signal: options.signal } : {}) });
    return { ok: true, skipped: false, ...report };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    console.warn('[RAG Dedupe] cluster recompute failed', { error: name, ...(error instanceof DupClusterError ? { code: error.code } : {}) });
    return { ok: false, error: name };
  }
}
