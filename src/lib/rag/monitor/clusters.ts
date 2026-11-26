import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import rawMonitorAlerts from '../../../../eval/config/monitor-alerts.json';
import { embedQueries, type QueryEmbedding } from '../embeddings/query-embedding';
import { tenantHash } from '../feedback-loop/mining';
import { seededRandom } from '../ingest/backfill/sample';
import {
  assignNearest,
  carryClusterIds,
  chooseK,
  distanceThreshold,
  mergeSmallClusters,
  normalize,
  sphericalKMeans,
  type CentroidRef,
} from './kmeans';

/**
 * Per-tenant topic clusters of masked production questions (D-40): the weekly sample's strata and the drift report's shares. The
 * masked queries of the last 30 days are embedded in memory through the active embedding profile; only centroids, member counts and
 * log-row assignments are stored, through rag_query_clusters_write and rag_query_cluster_assign under one tenant key.
 */

export interface ClusterSamplingConfig {
  max_queries: number;
  min_queries: number;
}

export type ClusterEmbedder = (texts: string[], signal: AbortSignal) => Promise<QueryEmbedding[]>;

export interface RefreshClustersOptions {
  tenantKey: string;
  now?: Date;
  embed?: ClusterEmbedder;
  config?: ClusterSamplingConfig;
  signal?: AbortSignal;
}

export type RefreshClustersResult =
  | { written: false; reason: 'too_few_queries'; queryCount: number }
  | {
      written: true;
      refit: boolean;
      setId: string;
      k: number;
      clusters: number;
      queryCount: number;
      embedded: number;
      assigned: number;
      novel: number;
      dropped: number;
    };

export const CLUSTER_WINDOW_DAYS = 30;
export const CLUSTER_REFIT_DAYS = 30;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 1000;
const EMBED_BATCH = 96;
const ASSIGN_CHUNK = 5000;
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const EMBEDDER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

interface LogRow {
  id: string;
  query_masked: string;
}

interface CurrentSet {
  id: string;
  embedder: string;
  dimension: number;
  fitted_at: string;
  distance_threshold: number;
}

interface Embedded {
  embedder: string;
  dimension: number;
  vectors: Map<string, Float32Array>;
}

/** The sampling block of eval/config/monitor-alerts.json (max_queries, min_queries). */
export function loadClusterSamplingConfig(raw: unknown = rawMonitorAlerts): ClusterSamplingConfig {
  const sampling = (raw as { sampling?: Record<string, unknown> } | null)?.sampling;
  const max = sampling?.max_queries;
  const min = sampling?.min_queries;
  if (!Number.isInteger(max) || !Number.isInteger(min) || (max as number) < 1 || (min as number) < 1) {
    throw new Error('[Monitor] eval/config/monitor-alerts.json sampling.max_queries and sampling.min_queries must be positive integers');
  }
  return { max_queries: max as number, min_queries: min as number };
}

function embedderIdOf(embedding: QueryEmbedding): string {
  const id = embedding.profile ? `profile:${embedding.profile.id}` : `legacy:${env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'}`;
  if (!EMBEDDER_RE.test(id)) throw new Error('[Monitor] embedder id is not a model or profile id token');
  return id;
}

/** Monday-based week index since the epoch: the subsample and the fit seed stay fixed within a week. */
function weekIndex(now: Date): number {
  return Math.floor((Math.floor(now.getTime() / DAY_MS) + 3) / 7);
}

function subsample<T extends { id: string }>(rows: readonly T[], max: number, seed: string): T[] {
  const ordered = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ordered.length <= max) return ordered;
  const random = seededRandom(seed, 'cluster-subsample');
  for (let i = ordered.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j] as T, ordered[i] as T];
  }
  return ordered.slice(0, max).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function failure(step: string, error: { code?: string; message?: string }): Error {
  return new Error(`[Monitor] clusters ${step} failed: ${error.code ?? 'unknown'}`);
}

async function readMaskedQueries(admin: SupabaseClient, tenantKey: string, since: Date, until: Date): Promise<LogRow[]> {
  const rows: LogRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_retrieval_log')
      .select('id, query_masked')
      .eq('tenant_key', tenantKey)
      .gte('created_at', since.toISOString())
      .lt('created_at', until.toISOString())
      .not('query_masked', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw failure('log read', error);
    const page = (data ?? []) as Array<{ id: unknown; query_masked: unknown }>;
    for (const row of page) {
      if (typeof row.id === 'string' && typeof row.query_masked === 'string' && row.query_masked.trim() !== '') {
        rows.push({ id: row.id, query_masked: row.query_masked });
      }
    }
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function readCurrentSet(admin: SupabaseClient, tenantKey: string): Promise<{ set: CurrentSet; clusters: CentroidRef[] } | null> {
  const { data, error } = await admin
    .from('rag_query_cluster_sets')
    .select('id, embedder, dimension, fitted_at, distance_threshold')
    .eq('tenant_key', tenantKey)
    .eq('status', 'current')
    .maybeSingle();
  if (error) throw failure('set read', error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const set: CurrentSet = {
    id: String(row.id),
    embedder: String(row.embedder),
    dimension: Number(row.dimension),
    fitted_at: String(row.fitted_at),
    distance_threshold: Number(row.distance_threshold),
  };
  const clusters = await admin
    .from('rag_query_clusters')
    .select('cluster_id, centroid')
    .eq('tenant_key', tenantKey)
    .eq('set_id', set.id)
    .order('cluster_id', { ascending: true });
  if (clusters.error) throw failure('cluster read', clusters.error);
  return {
    set,
    clusters: ((clusters.data ?? []) as Array<{ cluster_id: string; centroid: number[] }>).map((c) => ({
      clusterId: c.cluster_id,
      centroid: Float32Array.from(c.centroid.map(Number)),
    })),
  };
}

async function readAssignedLogIds(admin: SupabaseClient, tenantKey: string, setId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_query_cluster_assignments')
      .select('log_id')
      .eq('tenant_key', tenantKey)
      .eq('set_id', setId)
      .order('log_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw failure('assignment read', error);
    const page = (data ?? []) as Array<{ log_id: string }>;
    for (const row of page) ids.add(String(row.log_id));
    if (page.length < PAGE_SIZE) return ids;
  }
}

async function embedRows(rows: readonly LogRow[], embed: ClusterEmbedder, signal: AbortSignal, into?: Embedded): Promise<Embedded> {
  const out: Embedded = into ?? { embedder: '', dimension: 0, vectors: new Map() };
  const pending = rows.filter((row) => !out.vectors.has(row.id));
  for (let start = 0; start < pending.length; start += EMBED_BATCH) {
    const batch = pending.slice(start, start + EMBED_BATCH);
    const results = await embed(
      batch.map((row) => row.query_masked),
      signal,
    );
    if (results.length !== batch.length) throw new Error('[Monitor] embedder returned a different number of vectors');
    results.forEach((result, i) => {
      const embedder = embedderIdOf(result);
      const dimension = result.vector.length;
      if (out.embedder === '') {
        out.embedder = embedder;
        out.dimension = dimension;
      } else if (out.embedder !== embedder || out.dimension !== dimension) {
        throw new Error('[Monitor] the embedder changed during one cluster run');
      }
      out.vectors.set((batch[i] as LogRow).id, normalize(result.vector));
    });
  }
  return out;
}

async function writeAssignments(
  admin: SupabaseClient,
  tenantKey: string,
  setId: string,
  rows: Array<{ log_id: string; cluster_id: string; distance: number }>,
): Promise<{ stored: number; dropped: number }> {
  let stored = 0;
  let dropped = 0;
  for (let start = 0; start < rows.length; start += ASSIGN_CHUNK) {
    const { data, error } = await admin.rpc('rag_query_cluster_assign', {
      p_tenant_key: tenantKey,
      p_set_id: setId,
      p_rows: rows.slice(start, start + ASSIGN_CHUNK),
    });
    if (error) throw failure('assign', error);
    const result = (Array.isArray(data) ? data[0] : data) as { stored?: unknown; dropped?: unknown } | null;
    stored += Number(result?.stored ?? 0);
    dropped += Number(result?.dropped ?? 0);
  }
  return { stored, dropped };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Fits or extends the tenant's current cluster set. A refit happens when no current set exists, when it is CLUSTER_REFIT_DAYS old,
 * or when the running embedder id or dimension differs from the set's; otherwise only log rows not yet assigned to the set are
 * embedded and assigned to the nearest centroid or novel. Fewer than config.min_queries masked queries in the window writes nothing.
 */
export async function refreshClusters(admin: SupabaseClient, options: RefreshClustersOptions): Promise<RefreshClustersResult> {
  const { tenantKey } = options;
  if (!TENANT_KEY_RE.test(tenantKey)) throw new Error('[Monitor] clusters need one valid tenant key');
  const now = options.now ?? new Date();
  const embed = options.embed ?? embedQueries;
  const config = options.config ?? loadClusterSamplingConfig();
  const signal = options.signal ?? new AbortController().signal;
  const seed = `${tenantKey}:w${weekIndex(now)}`;

  const rows = await readMaskedQueries(admin, tenantKey, new Date(now.getTime() - CLUSTER_WINDOW_DAYS * DAY_MS), now);
  if (rows.length < config.min_queries) {
    console.log('[Monitor] clusters skipped: too few masked queries', { tenant: tenantHash(tenantKey), queries: rows.length, min: config.min_queries });
    return { written: false, reason: 'too_few_queries', queryCount: rows.length };
  }

  const current = await readCurrentSet(admin, tenantKey);
  let embedded: Embedded | undefined;

  if (current && now.getTime() - Date.parse(current.set.fitted_at) < CLUSTER_REFIT_DAYS * DAY_MS) {
    const assigned = await readAssignedLogIds(admin, tenantKey, current.set.id);
    const fresh = subsample(
      rows.filter((row) => !assigned.has(row.id)),
      config.max_queries,
      seed,
    );
    // With nothing new to assign, one already-read query is embedded to learn which embedder is running.
    embedded = await embedRows(fresh.length > 0 ? fresh : rows.slice(0, 1), embed, signal);
    if (embedded.embedder === current.set.embedder && embedded.dimension === current.set.dimension) {
      let novel = 0;
      const assignments = fresh.map((row) => {
        const hit = assignNearest(embedded?.vectors.get(row.id) as Float32Array, current.clusters, current.set.distance_threshold);
        if (hit.clusterId === 'novel') novel += 1;
        return { log_id: row.id, cluster_id: hit.clusterId, distance: round(hit.distance) };
      });
      const { stored, dropped } = await writeAssignments(admin, tenantKey, current.set.id, assignments);
      console.log('[Monitor] clusters assigned', { tenant: tenantHash(tenantKey), setId: current.set.id, assigned: stored, novel, dropped });
      return {
        written: true,
        refit: false,
        setId: current.set.id,
        k: current.clusters.length,
        clusters: current.clusters.length,
        queryCount: rows.length,
        embedded: embedded.vectors.size,
        assigned: stored,
        novel,
        dropped,
      };
    }
  }

  const sample = subsample(rows, config.max_queries, seed);
  embedded = await embedRows(sample, embed, signal, embedded);
  const vectors = sample.map((row) => embedded?.vectors.get(row.id) as Float32Array);
  const k = chooseK(vectors.length);
  const fitted = mergeSmallClusters(sphericalKMeans(vectors, { k, seed, maxIterations: 50 }), vectors, 5);
  const threshold = distanceThreshold(fitted, vectors, 0.95);
  const ids = carryClusterIds(current?.clusters ?? [], fitted.centroids, 0.85);
  const memberCounts = fitted.centroids.map(() => 0);
  for (const c of fitted.assignments) memberCounts[c] = (memberCounts[c] ?? 0) + 1;

  const { data: setId, error } = await admin.rpc('rag_query_clusters_write', {
    p_tenant_key: tenantKey,
    p_set: {
      embedder: embedded.embedder,
      dimension: embedded.dimension,
      k,
      query_count: vectors.length,
      distance_threshold: round(threshold),
      fitted_at: now.toISOString(),
    },
    p_clusters: fitted.centroids.map((centroid, i) => ({
      cluster_id: ids[i],
      centroid: Array.from(centroid),
      member_count: memberCounts[i],
    })),
  });
  if (error) throw failure('write', error);
  if (typeof setId !== 'string') throw new Error('[Monitor] clusters write returned no set id');

  const assignments = sample.map((row, i) => {
    const cluster = fitted.assignments[i] as number;
    const centroid = fitted.centroids[cluster] as Float32Array;
    const vector = vectors[i] as Float32Array;
    let similarity = 0;
    for (let d = 0; d < vector.length; d += 1) similarity += (vector[d] as number) * (centroid[d] as number);
    return { log_id: row.id, cluster_id: ids[cluster] as string, distance: round(Math.min(2, Math.max(0, 1 - similarity))) };
  });
  const { stored, dropped } = await writeAssignments(admin, tenantKey, setId, assignments);
  console.log('[Monitor] clusters refit', {
    tenant: tenantHash(tenantKey),
    setId,
    previousSetId: current?.set.id ?? null,
    k,
    clusters: fitted.centroids.length,
    embedded: vectors.length,
    assigned: stored,
    dropped,
  });
  return {
    written: true,
    refit: true,
    setId,
    k,
    clusters: fitted.centroids.length,
    queryCount: rows.length,
    embedded: vectors.length,
    assigned: stored,
    novel: 0,
    dropped,
  };
}
