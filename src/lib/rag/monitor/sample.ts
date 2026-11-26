import type { SupabaseClient } from '@supabase/supabase-js';
import rawMonitorAlerts from '../../../../eval/config/monitor-alerts.json';
import { readFeedbackLoopConfig, type FeedbackLoopEnvSource } from '../feedback-loop/config';
import { tenantHash } from '../feedback-loop/mining';
import { seededRandom } from '../ingest/backfill/sample';
import { refreshClusters, type ClusterEmbedder, type RefreshClustersResult } from './clusters';
import { monitorSettings, type MonitorEnvInput } from './config';

/**
 * The weekly representative sample of production questions (D-39, D-41, D-45, D-52). Per tenant, the masked log rows of the last ISO
 * week are split into strata (topic cluster x language x channel) and drawn into rag_review_items with reason representative. Up to
 * drift_fill_share of the cap goes to the clusters the latest drift report names as under-covered (drift_fill), then pilot users' rows
 * get pilot_multiplier times the rate of other rows within pilot_cap_share of the cap (pilot), and the rest is drawn proportionally
 * (representative). Each item stores the inverse of its inclusion probability within its source and stratum as sampling weight.
 * Nothing here logs or returns question text: counts, codes and the tenant hash only.
 */

export interface WeeklySampleConfig {
  weekly_cap: number;
  pilot_multiplier: number;
  pilot_cap_share: number;
  drift_fill_share: number;
}

export type SampleChannel = 'chat' | 'embed' | 'voice';
export type SampleSource = 'representative' | 'pilot' | 'drift_fill';
export type SamplePrerequisite = 'sample' | 'log' | 'review';

export interface SampleCandidateRow {
  id: string;
  trace_id: string | null;
  query_masked: string;
  query_fingerprint: string;
  language: string | null;
  channel: SampleChannel;
  user_id: string | null;
  cluster: string | null;
}

export interface PlannedItem {
  row: SampleCandidateRow;
  source: SampleSource;
  stratum: string;
  sampling_weight: number;
}

export interface SourceCounts {
  representative: number;
  pilot: number;
  drift_fill: number;
}

export interface WeeklySamplePlan {
  items: PlannedItem[];
  by_source: SourceCounts;
  by_language: Record<string, number>;
  excluded_queued: number;
}

export interface PlanWeeklySampleInput {
  tenantKey: string;
  week: string;
  config: WeeklySampleConfig;
  candidates: readonly SampleCandidateRow[];
  pilots: ReadonlySet<string>;
  underCovered: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  /** Items already drawn for this week (a rerun completes the week, never exceeds the cap). */
  alreadyDrawn?: number;
}

export type SampleEnv = MonitorEnvInput & FeedbackLoopEnvSource;

export interface DrawWeeklySampleOptions {
  tenantKey: string;
  now?: Date;
  config?: WeeklySampleConfig;
  embed?: ClusterEmbedder;
  env?: SampleEnv;
  signal?: AbortSignal;
}

export type DrawWeeklySampleResult =
  | { written: false; missing: SamplePrerequisite[] }
  | {
      written: true;
      week: string;
      mining_window: string;
      candidates: number;
      added: number;
      by_source: SourceCounts;
      by_language: Record<string, number>;
      excluded_queued: number;
      clusters: { refit: boolean; count: number; novel: number } | null;
    };

export interface SampleStatus {
  enabled: boolean;
  missing: SamplePrerequisite[];
  last_sample_at: string | null;
  added: number;
  by_source: SourceCounts;
  by_language: Record<string, number>;
  clusters: { count: number; refit_at: string | null; novel: number };
}

const DAY_MS = 86_400_000;
const PAGE_SIZE = 1000;
const IN_CHUNK = 200;
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const CLUSTER_RE = /^(c-[0-9]{2,3}|novel)$/;
const CHANNELS: readonly SampleChannel[] = ['chat', 'embed', 'voice'];
const SAMPLE_SOURCES: readonly SampleSource[] = ['representative', 'pilot', 'drift_fill'];
const UNKNOWN_LANGUAGE = 'und';
const NO_CLUSTER = 'none';

/** The weekly sample numbers of the sampling block of eval/config/monitor-alerts.json. */
export function loadSampleConfig(raw: unknown = rawMonitorAlerts): WeeklySampleConfig {
  const sampling = (raw as { sampling?: Record<string, unknown> } | null)?.sampling ?? {};
  const cap = sampling.weekly_cap;
  const multiplier = sampling.pilot_multiplier;
  const pilotShare = sampling.pilot_cap_share;
  const driftShare = sampling.drift_fill_share;
  const share = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!Number.isInteger(cap) || (cap as number) < 1 || typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1 || !share(pilotShare) || !share(driftShare)) {
    throw new Error('[Monitor] eval/config/monitor-alerts.json sampling needs weekly_cap, pilot_multiplier, pilot_cap_share and drift_fill_share');
  }
  return { weekly_cap: cap as number, pilot_multiplier: multiplier, pilot_cap_share: pilotShare as number, drift_fill_share: driftShare as number };
}

/** `YYYY-Www` of the ISO week that holds `date` (UTC). */
export function isoWeekLabel(date: Date): string {
  const day = Math.floor(date.getTime() / DAY_MS);
  const monday = day - ((new Date(day * DAY_MS).getUTCDay() + 6) % 7);
  const thursday = new Date((monday + 3) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The ISO week before the one that holds `now`: [Monday 00:00 UTC, next Monday). */
export function sampleWindow(now: Date): { since: string; until: string; week: string } {
  const day = Math.floor(now.getTime() / DAY_MS);
  const thisMonday = day - ((new Date(day * DAY_MS).getUTCDay() + 6) % 7);
  const since = new Date((thisMonday - 7) * DAY_MS);
  return { since: since.toISOString(), until: new Date(thisMonday * DAY_MS).toISOString(), week: isoWeekLabel(since) };
}

/** `cluster|language|channel`; a row without a cluster is `none`, without a detected language `und`. */
export function stratumKey(row: { cluster: string | null; language: string | null; channel: string }): string {
  const cluster = row.cluster && CLUSTER_RE.test(row.cluster) ? row.cluster : NO_CLUSTER;
  const language = row.language && LANGUAGE_RE.test(row.language) ? row.language : UNKNOWN_LANGUAGE;
  return `${cluster}|${language}|${row.channel}`;
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Proportional allocation of `cap` items over strata by largest remainder (ties by stratum key), at most a stratum's size, at least one
 * item per non-empty stratum. When there are more non-empty strata than the cap, the lowest shares are dropped first (ties by key) and
 * every kept stratum gets one item.
 */
export function allocateStrata(strata: ReadonlyArray<{ key: string; size: number }>, cap: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const stratum of strata) out.set(stratum.key, 0);
  const nonEmpty = strata.filter((stratum) => stratum.size > 0).sort((a, b) => byKey(a.key, b.key));
  const total = nonEmpty.reduce((sum, stratum) => sum + stratum.size, 0);
  const limit = Math.max(0, Math.floor(cap));
  if (limit === 0 || total === 0) return out;
  if (total <= limit) {
    for (const stratum of nonEmpty) out.set(stratum.key, stratum.size);
    return out;
  }
  if (nonEmpty.length >= limit) {
    const kept = [...nonEmpty].sort((a, b) => b.size - a.size || byKey(a.key, b.key)).slice(0, limit);
    for (const stratum of kept) out.set(stratum.key, 1);
    return out;
  }

  const quota = new Map(nonEmpty.map((stratum) => [stratum.key, (limit * stratum.size) / total]));
  let assigned = 0;
  for (const stratum of nonEmpty) {
    const n = Math.min(stratum.size, Math.floor(quota.get(stratum.key) as number));
    out.set(stratum.key, n);
    assigned += n;
  }
  while (assigned < limit) {
    let best: string | null = null;
    let bestRemainder = -Infinity;
    for (const stratum of nonEmpty) {
      const n = out.get(stratum.key) as number;
      if (n >= stratum.size) continue;
      const remainder = (quota.get(stratum.key) as number) - n;
      if (remainder > bestRemainder + 1e-12) {
        best = stratum.key;
        bestRemainder = remainder;
      }
    }
    if (best === null) break;
    out.set(best, (out.get(best) as number) + 1);
    assigned += 1;
  }
  for (const stratum of nonEmpty) {
    if ((out.get(stratum.key) as number) > 0) continue;
    let donor: string | null = null;
    let donorExcess = -Infinity;
    for (const other of nonEmpty) {
      const n = out.get(other.key) as number;
      if (n <= 1) continue;
      const excess = n - (quota.get(other.key) as number);
      if (excess > donorExcess + 1e-12) {
        donor = other.key;
        donorExcess = excess;
      }
    }
    if (donor === null) break;
    out.set(donor, (out.get(donor) as number) - 1);
    out.set(stratum.key, 1);
  }
  return out;
}

function groupByStratum(rows: readonly SampleCandidateRow[]): Map<string, SampleCandidateRow[]> {
  const groups = new Map<string, SampleCandidateRow[]>();
  for (const row of rows) {
    const key = stratumKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  for (const list of groups.values()) list.sort((a, b) => byKey(a.id, b.id));
  return groups;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Draws `target` items from one pool; each stratum's rows are shuffled with a seed of tenant, week, source and stratum. */
function drawPool(
  pool: readonly SampleCandidateRow[],
  target: number,
  source: SampleSource,
  seed: string,
  chosen: Set<string>,
): PlannedItem[] {
  if (target <= 0 || pool.length === 0) return [];
  const groups = groupByStratum(pool);
  const quotas = allocateStrata(
    [...groups].map(([key, rows]) => ({ key, size: rows.length })),
    target,
  );
  const items: PlannedItem[] = [];
  for (const key of [...groups.keys()].sort(byKey)) {
    const want = quotas.get(key) ?? 0;
    if (want <= 0) continue;
    const rows = [...(groups.get(key) as SampleCandidateRow[])];
    const random = seededRandom(seed, `${source}|${key}`);
    for (let i = rows.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [rows[i], rows[j]] = [rows[j] as SampleCandidateRow, rows[i] as SampleCandidateRow];
    }
    const taken: SampleCandidateRow[] = [];
    for (const row of rows) {
      if (taken.length >= want) break;
      if (chosen.has(row.query_fingerprint)) continue;
      chosen.add(row.query_fingerprint);
      taken.push(row);
    }
    if (taken.length === 0) continue;
    const weight = round6(rows.length / taken.length);
    for (const row of taken) items.push({ row, source, stratum: key, sampling_weight: weight });
  }
  return items;
}

/**
 * The pure part of the weekly draw: queued fingerprints out, then drift_fill, pilot and representative pools in that order, one item per
 * fingerprint. Pools partition the candidates, so the stored weights (stratum rows / stratum items within a source) stay unbiased.
 */
export function planWeeklySample(input: PlanWeeklySampleInput): WeeklySamplePlan {
  const { config } = input;
  const seed = `${input.tenantKey}:${input.week}`;
  const excluded = new Set<string>();
  const candidates = input.candidates.filter((row) => {
    if (!input.queued.has(row.query_fingerprint)) return true;
    excluded.add(row.query_fingerprint);
    return false;
  });
  const cap = Math.max(0, config.weekly_cap - (input.alreadyDrawn ?? 0));
  const chosen = new Set<string>();

  const driftPool = candidates.filter((row) => row.cluster !== null && input.underCovered.has(row.cluster));
  const rest = candidates.filter((row) => !(row.cluster !== null && input.underCovered.has(row.cluster)));
  const pilotPool = rest.filter((row) => row.user_id !== null && input.pilots.has(row.user_id));
  const representativePool = rest.filter((row) => !(row.user_id !== null && input.pilots.has(row.user_id)));

  const driftTarget = Math.min(Math.floor(cap * config.drift_fill_share), driftPool.length);
  const drift = drawPool(driftPool, driftTarget, 'drift_fill', seed, chosen);

  const remaining = cap - drift.length;
  const pilotCap = Math.floor(config.weekly_cap * config.pilot_cap_share);
  let pilotTarget = 0;
  if (pilotPool.length > 0 && remaining > 0) {
    const pilotMass = config.pilot_multiplier * pilotPool.length;
    pilotTarget = Math.min(pilotCap, pilotPool.length, remaining, Math.round((remaining * pilotMass) / (pilotMass + representativePool.length)));
    const representativeRoom = Math.min(representativePool.length, remaining - pilotTarget);
    if (representativeRoom < remaining - pilotTarget) pilotTarget = Math.min(pilotCap, pilotPool.length, remaining - representativeRoom);
  }
  const pilot = drawPool(pilotPool, pilotTarget, 'pilot', seed, chosen);
  const representative = drawPool(representativePool, remaining - pilot.length, 'representative', seed, chosen);

  const items = [...drift, ...pilot, ...representative];
  const by_language: Record<string, number> = {};
  for (const item of items) {
    const language = item.stratum.split('|')[1] as string;
    by_language[language] = (by_language[language] ?? 0) + 1;
  }
  return {
    items,
    by_source: { representative: representative.length, pilot: pilot.length, drift_fill: drift.length },
    by_language,
    excluded_queued: excluded.size,
  };
}

function prerequisites(env: SampleEnv): { enabled: boolean; missing: SamplePrerequisite[] } {
  const feedback = readFeedbackLoopConfig(env, () => undefined);
  const missing: SamplePrerequisite[] = [];
  if (feedback.retrievalLog !== 'masked_query') missing.push('log');
  if (!feedback.domainExpertReview) missing.push('review');
  return { enabled: monitorSettings(env).representativeSample, missing };
}

/** Every missing prerequisite of a draw: the switch (sample), the masked_query log (log) and expert review (review). */
export function missingSamplePrerequisites(env: SampleEnv = process.env as SampleEnv): SamplePrerequisite[] {
  const check = prerequisites(env);
  return [...(check.enabled ? [] : (['sample'] as const)), ...check.missing];
}

class SampleError extends Error {
  constructor(readonly operation: string, readonly code: string) {
    super(`[Monitor] sample ${operation} failed (${code})`);
    this.name = 'SampleError';
  }
}

function fail(operation: string, error: { code?: unknown } | null): SampleError {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code) ? error.code : 'unknown';
  return new SampleError(operation, code);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

async function readWeekRows(admin: SupabaseClient, tenantKey: string, since: string, until: string): Promise<SampleCandidateRow[]> {
  const rows: SampleCandidateRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_retrieval_log')
      .select('id, trace_id, user_id, channel, query_language, query_masked, query_fingerprint')
      .eq('tenant_key', tenantKey)
      .gte('created_at', since)
      .lt('created_at', until)
      .not('query_masked', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw fail('log read', error);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of page) {
      const channel = CHANNELS.find((value) => value === row.channel);
      if (typeof row.id !== 'string' || typeof row.query_masked !== 'string' || row.query_masked.trim() === '') continue;
      if (typeof row.query_fingerprint !== 'string' || !FINGERPRINT_RE.test(row.query_fingerprint) || !channel) continue;
      rows.push({
        id: row.id,
        trace_id: typeof row.trace_id === 'string' ? row.trace_id : null,
        query_masked: row.query_masked,
        query_fingerprint: row.query_fingerprint,
        language: typeof row.query_language === 'string' && LANGUAGE_RE.test(row.query_language) ? row.query_language : null,
        channel,
        user_id: typeof row.user_id === 'string' ? row.user_id : null,
        cluster: null,
      });
    }
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function currentSet(admin: SupabaseClient, tenantKey: string): Promise<{ id: string; fitted_at: string } | null> {
  const { data, error } = await admin
    .from('rag_query_cluster_sets')
    .select('id, fitted_at')
    .eq('tenant_key', tenantKey)
    .eq('status', 'current')
    .maybeSingle();
  if (error) throw fail('cluster set read', error);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return { id: String(row.id), fitted_at: String(row.fitted_at) };
}

async function readAssignments(admin: SupabaseClient, tenantKey: string, setId: string, logIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks(logIds, IN_CHUNK)) {
    const { data, error } = await admin
      .from('rag_query_cluster_assignments')
      .select('log_id, cluster_id')
      .eq('tenant_key', tenantKey)
      .eq('set_id', setId)
      .in('log_id', part);
    if (error) throw fail('assignment read', error);
    for (const row of (data ?? []) as Array<{ log_id: unknown; cluster_id: unknown }>) {
      if (typeof row.cluster_id === 'string' && CLUSTER_RE.test(row.cluster_id)) out.set(String(row.log_id), row.cluster_id);
    }
  }
  return out;
}

async function readQueuedFingerprints(admin: SupabaseClient, tenantKey: string, fingerprints: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(fingerprints, IN_CHUNK)) {
    const { data, error } = await admin.from('rag_review_items').select('query_fingerprint').eq('tenant_key', tenantKey).in('query_fingerprint', part);
    if (error) throw fail('queue read', error);
    for (const row of (data ?? []) as Array<{ query_fingerprint: unknown }>) {
      if (typeof row.query_fingerprint === 'string') out.add(row.query_fingerprint);
    }
  }
  return out;
}

async function readPilots(admin: SupabaseClient, tenantKey: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_pilot_users')
      .select('user_id')
      .eq('tenant_key', tenantKey)
      .order('user_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw fail('pilot read', error);
    const page = (data ?? []) as Array<{ user_id: unknown }>;
    for (const row of page) out.add(String(row.user_id));
    if (page.length < PAGE_SIZE) return out;
  }
}

/** The cluster ids the latest drift report marks under-covered. */
async function readUnderCovered(admin: SupabaseClient, tenantKey: string): Promise<Set<string>> {
  const { data, error } = await admin
    .from('rag_drift_weekly')
    .select('report')
    .eq('tenant_key', tenantKey)
    .order('week', { ascending: false })
    .limit(1);
  if (error) throw fail('drift read', error);
  const report = ((data ?? []) as Array<{ report?: unknown }>)[0]?.report as { clusters?: unknown } | undefined;
  const out = new Set<string>();
  for (const cluster of Array.isArray(report?.clusters) ? (report.clusters as Array<Record<string, unknown>>) : []) {
    if (cluster?.state === 'under' && typeof cluster.id === 'string' && CLUSTER_RE.test(cluster.id) && cluster.id !== 'novel') out.add(cluster.id);
  }
  return out;
}

/** The review items of one tenant and window with reason representative, and their strata rows (historical imports left out). */
async function readWindowItems(
  admin: SupabaseClient,
  tenantKey: string,
  window: string,
): Promise<Array<{ id: string; source: SampleSource; stratum: string; created_at: string }>> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_review_items')
      .select('id')
      .eq('tenant_key', tenantKey)
      .eq('mining_window', window)
      .contains('reasons', ['representative'])
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw fail('window read', error);
    const page = (data ?? []) as Array<{ id: unknown }>;
    for (const row of page) ids.push(String(row.id));
    if (page.length < PAGE_SIZE) break;
  }
  const out: Array<{ id: string; source: SampleSource; stratum: string; created_at: string }> = [];
  for (const part of chunks(ids, IN_CHUNK)) {
    const { data, error } = await admin
      .from('rag_review_item_strata')
      .select('review_item_id, source, stratum, created_at')
      .eq('tenant_key', tenantKey)
      .in('review_item_id', part);
    if (error) throw fail('strata read', error);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const source = SAMPLE_SOURCES.find((value) => value === row.source);
      if (!source) continue;
      out.push({ id: String(row.review_item_id), source, stratum: String(row.stratum), created_at: String(row.created_at) });
    }
  }
  return out;
}

async function enqueue(admin: SupabaseClient, tenantKey: string, source: SampleSource, items: readonly PlannedItem[], window: string): Promise<number> {
  if (items.length === 0) return 0;
  const { data, error } = await admin.rpc('rag_review_items_enqueue', {
    p_tenant_key: tenantKey,
    p_source: source,
    p_rows: items.map((item) => ({
      retrieval_log_id: item.row.id,
      trace_id: item.row.trace_id,
      query_masked: item.row.query_masked,
      query_fingerprint: item.row.query_fingerprint,
      language: item.row.language,
      channel: item.row.channel,
      mining_window: window,
      stratum: item.stratum,
      sampling_weight: item.sampling_weight,
      reasons: ['representative'],
    })),
  });
  if (error) throw fail('enqueue', error);
  return Number(data ?? 0);
}

/**
 * D-41: draws one tenant's sample of the last ISO week. Needs RAG_REPRESENTATIVE_SAMPLE=true, RAG_RETRIEVAL_LOG=masked_query and
 * RAG_DOMAIN_EXPERT_REVIEW=true; otherwise returns the missing prerequisites and reads nothing. Refreshes the tenant's clusters first.
 * A rerun in the same week only tops the week up to the cap.
 */
export async function drawWeeklySample(admin: SupabaseClient, options: DrawWeeklySampleOptions): Promise<DrawWeeklySampleResult> {
  const { tenantKey } = options;
  if (!TENANT_KEY_RE.test(tenantKey)) throw new Error('[Monitor] the sample needs one valid tenant key');
  const env = options.env ?? (process.env as SampleEnv);
  const missing = missingSamplePrerequisites(env);
  if (missing.length > 0) return { written: false, missing };

  const now = options.now ?? new Date();
  const config = options.config ?? loadSampleConfig();
  const window = sampleWindow(now);

  const refreshed: RefreshClustersResult = await refreshClusters(admin, { tenantKey, now, embed: options.embed, signal: options.signal });

  const rows = await readWeekRows(admin, tenantKey, window.since, window.until);
  const set = await currentSet(admin, tenantKey);
  if (set && rows.length > 0) {
    const assignments = await readAssignments(
      admin,
      tenantKey,
      set.id,
      rows.map((row) => row.id),
    );
    for (const row of rows) row.cluster = assignments.get(row.id) ?? null;
  }
  const queued = await readQueuedFingerprints(admin, tenantKey, [...new Set(rows.map((row) => row.query_fingerprint))]);
  const pilots = await readPilots(admin, tenantKey);
  const underCovered = await readUnderCovered(admin, tenantKey);
  const alreadyDrawn = (await readWindowItems(admin, tenantKey, window.since)).length;

  const plan = planWeeklySample({ tenantKey, week: window.week, config, candidates: rows, pilots, underCovered, queued, alreadyDrawn });
  const by_source: SourceCounts = { representative: 0, pilot: 0, drift_fill: 0 };
  for (const source of ['drift_fill', 'pilot', 'representative'] as const) {
    by_source[source] = await enqueue(
      admin,
      tenantKey,
      source,
      plan.items.filter((item) => item.source === source),
      window.since,
    );
  }
  const added = by_source.representative + by_source.pilot + by_source.drift_fill;
  const clusters = refreshed.written ? { refit: refreshed.refit, count: refreshed.clusters, novel: refreshed.novel } : null;
  console.log('[Monitor] weekly sample drawn', {
    tenant: tenantHash(tenantKey),
    week: window.week,
    candidates: rows.length,
    added,
    ...by_source,
    excludedQueued: plan.excluded_queued,
  });
  return {
    written: true,
    week: window.week,
    mining_window: window.since,
    candidates: rows.length,
    added,
    by_source,
    by_language: plan.by_language,
    excluded_queued: plan.excluded_queued,
    clusters,
  };
}

/** The tenant keys with masked log rows in the sampled week, sorted. */
export async function sampleTenants(admin: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const window = sampleWindow(now);
  const tenants = new Set<string>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_retrieval_log')
      .select('id, tenant_key')
      .gte('created_at', window.since)
      .lt('created_at', window.until)
      .not('query_masked', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw fail('tenant read', error);
    const page = (data ?? []) as Array<{ tenant_key: unknown }>;
    for (const row of page) if (typeof row.tenant_key === 'string' && TENANT_KEY_RE.test(row.tenant_key)) tenants.add(row.tenant_key);
    if (page.length < PAGE_SIZE) return [...tenants].sort(byKey);
  }
}

async function countNovel(admin: SupabaseClient, tenantKey: string, setId: string): Promise<number> {
  let total = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_query_cluster_assignments')
      .select('log_id')
      .eq('tenant_key', tenantKey)
      .eq('set_id', setId)
      .eq('cluster_id', 'novel')
      .order('log_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw fail('novel read', error);
    const page = (data ?? []) as unknown[];
    total += page.length;
    if (page.length < PAGE_SIZE) return total;
  }
}

/** UI-SPEC 6.10.1: the switch, missing prerequisites, the latest sampled week's counts and the cluster set, all as counts and dates. */
export async function sampleStatus(admin: SupabaseClient, tenantKey: string, options: { env?: SampleEnv } = {}): Promise<SampleStatus> {
  if (!TENANT_KEY_RE.test(tenantKey)) throw new Error('[Monitor] the sample status needs one valid tenant key');
  const check = prerequisites(options.env ?? (process.env as SampleEnv));
  const by_source: SourceCounts = { representative: 0, pilot: 0, drift_fill: 0 };
  const by_language: Record<string, number> = {};

  const latest = await admin
    .from('rag_review_items')
    .select('mining_window')
    .eq('tenant_key', tenantKey)
    .contains('reasons', ['representative'])
    .order('mining_window', { ascending: false })
    .limit(1);
  if (latest.error) throw fail('status read', latest.error);
  const window = ((latest.data ?? []) as Array<{ mining_window?: unknown }>)[0]?.mining_window;
  let last: string | null = null;
  let added = 0;
  if (typeof window === 'string') {
    for (const item of await readWindowItems(admin, tenantKey, window)) {
      added += 1;
      by_source[item.source] += 1;
      const language = item.stratum.split('|')[1] ?? UNKNOWN_LANGUAGE;
      by_language[language] = (by_language[language] ?? 0) + 1;
      if (last === null || Date.parse(item.created_at) > Date.parse(last)) last = item.created_at;
    }
  }

  const set = await currentSet(admin, tenantKey);
  let count = 0;
  let novel = 0;
  if (set) {
    const clusters = await admin.from('rag_query_clusters').select('cluster_id').eq('tenant_key', tenantKey).eq('set_id', set.id);
    if (clusters.error) throw fail('cluster read', clusters.error);
    count = ((clusters.data ?? []) as unknown[]).length;
    novel = await countNovel(admin, tenantKey, set.id);
  }
  return {
    enabled: check.enabled,
    missing: check.missing,
    last_sample_at: last ? new Date(last).toISOString() : null,
    added,
    by_source,
    by_language,
    clusters: { count, refit_at: set ? new Date(set.fitted_at).toISOString() : null, novel },
  };
}
