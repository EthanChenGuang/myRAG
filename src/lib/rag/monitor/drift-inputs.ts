import type { SupabaseClient } from '@supabase/supabase-js';
import { tenantHash } from '../feedback-loop/mining';

/**
 * D-43: the production side of the weekly drift report, per tenant and as numbers only. Cluster shares of the last 30 days come from
 * rag_monitor_cluster_shares (log rows assigned in the tenant's current cluster set, novel included); online judge means, vote and
 * refusal rates per slice come from the rag_monitor_daily sums. No question, answer or other text is read.
 */

export const DRIFT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 1000;
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const TOKEN_RE = /^[A-Za-z0-9_.|-]{1,64}$/;

export interface DriftInputCluster {
  id: string;
  n: number;
  share: number;
}

export interface DriftInputRate {
  value: number | null;
  count: number;
  n: number;
}

export interface DriftInputSlice {
  /** `all`, `language:<code>` or `channel:<channel>` (the SliceKey shape of DriftGap and DriftRate). */
  slice: string;
  online_judge: { mean: number | null; n: number };
  not_helpful_rate: DriftInputRate;
  refusal_rate: DriftInputRate;
}

export interface DriftInputs {
  tenant_hash: string;
  window: { days: number; since: string; until: string };
  total: number;
  clusters: DriftInputCluster[];
  slices: DriftInputSlice[];
}

interface Sums {
  retrievals: number;
  refused: number;
  helpful: number;
  not_helpful: number;
  judged: number;
  judge: Map<string, number>;
}

function failure(step: string, error: { code?: string } | null): Error {
  return Object.assign(new Error(`[Monitor] drift inputs ${step} failed: ${error?.code ?? 'unknown'}`), { operation: step });
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function language(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return code === '' || code === 'unknown' || !TOKEN_RE.test(code) ? 'und' : code;
}

function emptySums(): Sums {
  return { retrievals: 0, refused: 0, helpful: 0, not_helpful: 0, judged: 0, judge: new Map() };
}

function rate(count: number, n: number): DriftInputRate {
  return { value: n > 0 ? count / n : null, count, n };
}

/** The rule-kinds judge mean: the mean over metrics of each metric's sum divided by the judged count. */
function judgeMean(sums: Sums): number | null {
  if (sums.judged <= 0 || sums.judge.size === 0) return null;
  let total = 0;
  for (const value of sums.judge.values()) total += value / sums.judged;
  return total / sums.judge.size;
}

async function clusterShares(admin: SupabaseClient, tenantKey: string, since: Date): Promise<{ total: number; clusters: DriftInputCluster[] }> {
  const { data, error } = await admin.rpc('rag_monitor_cluster_shares', { p_tenant_key: tenantKey, p_since: since.toISOString() });
  if (error) throw failure('cluster shares', error);
  const counts = new Map<string, number>();
  for (const row of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
    const id = typeof row.cluster_id === 'string' ? row.cluster_id : '';
    if (id === '') continue;
    counts.set(id, (counts.get(id) ?? 0) + num(row.n));
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const clusters = [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, n]) => ({ id, n, share: n / total }));
  return { total, clusters };
}

async function dailySums(admin: SupabaseClient, tenantKey: string, sinceDay: string, untilDay: string): Promise<Map<string, Sums>> {
  const slices = new Map<string, Sums>([['all', emptySums()]]);
  const add = (key: string, row: Record<string, unknown>) => {
    let sums = slices.get(key);
    if (!sums) {
      sums = emptySums();
      slices.set(key, sums);
    }
    sums.retrievals += num(row.retrievals);
    sums.refused += num(row.refused);
    sums.helpful += num(row.helpful);
    sums.not_helpful += num(row.not_helpful);
    sums.judged += num(row.judged);
    const judge = row.judge_score_sums;
    if (judge && typeof judge === 'object') {
      for (const [metric, value] of Object.entries(judge as Record<string, unknown>)) {
        if (!TOKEN_RE.test(metric)) continue;
        sums.judge.set(metric, (sums.judge.get(metric) ?? 0) + (Number(value) || 0));
      }
    }
  };
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('rag_monitor_daily')
      .select('day, language, channel, retrievals, refused, helpful, not_helpful, judged, judge_score_sums')
      .eq('tenant_key', tenantKey)
      .gte('day', sinceDay)
      .lt('day', untilDay)
      .order('day', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw failure('daily read', error);
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of page) {
      add('all', row);
      add(`language:${language(row.language)}`, row);
      const channel = typeof row.channel === 'string' && TOKEN_RE.test(row.channel) ? row.channel : 'und';
      add(`channel:${channel}`, row);
    }
    if (page.length < PAGE_SIZE) return slices;
  }
}

/** The drift inputs of one tenant over the DRIFT_WINDOW_DAYS before `now`. */
export async function driftInputs(admin: SupabaseClient, options: { tenantKey: string; now?: Date }): Promise<DriftInputs> {
  const { tenantKey } = options;
  if (!TENANT_KEY_RE.test(tenantKey)) throw new Error('[Monitor] drift inputs need one valid tenant key');
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - DRIFT_WINDOW_DAYS * DAY_MS);
  const untilDay = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  const shares = await clusterShares(admin, tenantKey, since);
  const sums = await dailySums(admin, tenantKey, since.toISOString().slice(0, 10), untilDay);
  const slices = [...sums.entries()]
    .sort(([a], [b]) => (a === 'all' ? -1 : b === 'all' ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([slice, s]) => ({
      slice,
      online_judge: { mean: judgeMean(s), n: s.judged },
      not_helpful_rate: rate(s.not_helpful, s.helpful + s.not_helpful),
      refusal_rate: rate(s.refused, s.retrievals),
    }));
  console.log('[Monitor] drift inputs read', { tenant: tenantHash(tenantKey), clusters: shares.clusters.length, total: shares.total, slices: slices.length });
  return {
    tenant_hash: tenantHash(tenantKey),
    window: { days: DRIFT_WINDOW_DAYS, since: since.toISOString(), until: now.toISOString() },
    total: shares.total,
    clusters: shares.clusters,
    slices,
  };
}
