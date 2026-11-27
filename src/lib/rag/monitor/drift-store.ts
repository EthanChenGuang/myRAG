import type { SupabaseClient } from '@supabase/supabase-js';
import { DriftReportSchema, type DriftReport, type MonitorAlertsConfig } from '@/lib/rag-eval/contracts.generated';
import { tenantHash } from '../feedback-loop/mining';
import { upsertAlerts, type DeliveryChannel } from './alerts-store';
import { driftAlerts, isoWeekLastDay } from './rules';
import { isoWeekLabel } from './sample';

/**
 * Weekly test-set drift per tenant (D-43 to D-45). A posted DriftReport is validated, its derived fields (state, cluster states, gap
 * values and verdicts, limits) are recomputed from its numbers and the committed bands, and it is stored in rag_drift_weekly through
 * rag_drift_weekly_upsert. With RAG_MONITOR on, driftAlerts turns it into test_set_not_representative and offline_online_gap alerts.
 * Only ids, shares, counts and code words are stored; the latest report's under-covered clusters feed the next weekly sample.
 */

const DAY_MS = 86_400_000;
const TREND_WEEKS = 8;
const EPSILON = 1e-9;
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type DriftState = DriftReport['state'];
export type Details = Array<{ path: string; message: string }>;

export interface StoreDriftReportOptions {
  tenantKey: string;
  report: unknown;
  config: MonitorAlertsConfig;
  monitorOn: boolean;
  /** Delivery channels queued for a new alert (the webhook when configured). */
  channels?: readonly DeliveryChannel[];
  now?: Date;
}

export type StoreDriftReportResult =
  | { ok: true; week: string; state: DriftState; inserted: boolean; alerts: { opened: number; updated: number } }
  | { ok: false; reason: 'invalid_report'; details: Details };

export interface DriftLimits {
  warn: number;
  alert: number;
  gap: number;
}

export interface DriftView {
  week: string | null;
  divergence: number | null;
  null_p95: number | null;
  state: DriftState | null;
  limits: DriftLimits;
  trend: Array<{ week: string; divergence: number; state: DriftState }>;
  clusters: NonNullable<DriftReport['clusters']>;
  scores?: NonNullable<DriftReport['scores']>;
  gaps?: NonNullable<DriftReport['gaps']>;
  rates?: NonNullable<DriftReport['rates']>;
}

function failure(step: string, error: { code?: string } | null): Error {
  return Object.assign(new Error(`[Monitor] drift ${step} failed: ${error?.code ?? 'unknown'}`), { operation: step });
}

export function driftLimits(config: MonitorAlertsConfig): DriftLimits {
  return { warn: config.drift.jsd_warn, alert: config.drift.jsd_alert, gap: config.drift.gap_alert };
}

/** The Monday (YYYY-MM-DD) of an ISO week, or null when the label names no week of its year. */
export function isoWeekMonday(week: string): string | null {
  if (!/^\d{4}-W\d{2}$/.test(week)) return null;
  const monday = new Date(Date.parse(`${isoWeekLastDay(week)}T00:00:00Z`) - 6 * DAY_MS);
  return isoWeekLabel(monday) === week ? monday.toISOString().slice(0, 10) : null;
}

function rule(config: MonitorAlertsConfig, kind: string) {
  return config.rules.find((r) => r.enabled && r.kind === kind) ?? null;
}

/** The report with every derived field recomputed; nothing the client asserted about a state is kept. */
function recompute(report: DriftReport, config: MonitorAlertsConfig, tenantKey: string): DriftReport {
  const bands = config.drift;
  const tolerance = config.sampling.quota_tolerance;
  const clusters = (report.clusters ?? []).map((cluster) => {
    const under =
      cluster.production_share >= bands.under_covered_min_share - EPSILON && cluster.test_share < bands.under_covered_ratio * cluster.production_share;
    const off = Math.abs(cluster.test_share - cluster.production_share) > tolerance + EPSILON;
    return { ...cluster, state: under ? ('under' as const) : off ? ('off' as const) : ('ok' as const) };
  });
  const gapRule = rule(config, 'offline_online_gap');
  const gapAlert = gapRule?.alert ?? bands.gap_alert;
  const gapMin = gapRule?.min_sample ?? 0;
  const gaps = (report.gaps ?? []).map((slice) => {
    const gap = slice.offline != null && slice.online != null ? slice.offline - slice.online : null;
    const result: 'passed' | 'failed' | 'insufficient_n' =
      gap === null || slice.online_n < gapMin ? 'insufficient_n' : gap >= gapAlert - EPSILON ? 'failed' : 'passed';
    return { ...slice, gap, result };
  });
  const base: DriftReport = {
    week: report.week,
    tenant_hash: tenantHash(tenantKey),
    divergence: report.divergence,
    null_p95: report.null_p95,
    state: 'ok',
    limits: driftLimits(config),
    clusters,
    scores: report.scores ?? null,
    ...(gaps.length > 0 ? { gaps } : {}),
    ...(report.rates && report.rates.length > 0 ? { rates: report.rates } : {}),
  };
  const drift = driftAlerts({ tenantKey, report: base, config }).find((candidate) => candidate.kind === 'drift');
  return { ...base, state: drift ? (drift.severity === 'alert' ? 'alert' : 'warn') : 'ok' };
}

function issuesOf(error: { errors: Array<{ path: Array<string | number>; message: string }> }): Details {
  return error.errors.map((issue) => ({ path: ['report', ...issue.path].join('.'), message: issue.message }));
}

/** Validates, recomputes and stores one tenant's weekly report; with monitorOn the drift alerts go through the alert store. */
export async function storeDriftReport(admin: SupabaseClient, options: StoreDriftReportOptions): Promise<StoreDriftReportResult> {
  const { tenantKey, config } = options;
  if (!TENANT_KEY_RE.test(tenantKey)) throw new Error('[Monitor] drift reports need one valid tenant key');
  const parsed = DriftReportSchema.safeParse(options.report);
  if (!parsed.success) return { ok: false, reason: 'invalid_report', details: issuesOf(parsed.error) };
  const details: Details = [];
  const monday = isoWeekMonday(parsed.data.week);
  if (!monday) details.push({ path: 'report.week', message: 'week must name an ISO week' });
  if (parsed.data.divergence == null) details.push({ path: 'report.divergence', message: 'divergence is required to store a weekly report' });
  if (details.length > 0 || !monday) return { ok: false, reason: 'invalid_report', details };

  const report = recompute(parsed.data, config, tenantKey);
  const { data, error } = await admin.rpc('rag_drift_weekly_upsert', { p_tenant_key: tenantKey, p_week: monday, p_report: report });
  if (error) throw failure('store', error);
  const inserted = data === true;

  const alerts = { opened: 0, updated: 0 };
  if (options.monitorOn) {
    const candidates = driftAlerts({ tenantKey, report, config });
    const stored = await upsertAlerts(
      admin,
      candidates.map((candidate) => ({ candidate, evidence: { sampleTraceIds: [], configChanges: [] }, channels: options.channels ?? [] })),
      options.now ?? new Date(),
    );
    alerts.opened = stored.opened;
    alerts.updated = stored.updated;
  }
  console.log('[Monitor] drift report stored', {
    tenant: tenantHash(tenantKey),
    week: report.week,
    state: report.state,
    inserted,
    under_covered: (report.clusters ?? []).filter((c) => c.state === 'under').length,
    alerts_opened: alerts.opened,
    alerts_updated: alerts.updated,
  });
  return { ok: true, week: report.week, state: report.state, inserted, alerts };
}

interface WeeklyRow {
  week: string;
  divergence: number;
  null_p95: number | null;
  state: DriftState;
  report: Partial<DriftReport> | null;
}

function weekLabelOf(day: string): string {
  return isoWeekLabel(new Date(`${day.slice(0, 10)}T00:00:00Z`));
}

/** The Test set coverage view (UI-SPEC 6.8, 8.1): the latest week, the trend of the 8 weeks up to it, cluster rows and limits. */
export async function latestDrift(admin: SupabaseClient, tenantKey: string, config: MonitorAlertsConfig): Promise<DriftView> {
  if (!TENANT_KEY_RE.test(tenantKey)) throw new Error('[Monitor] drift reports need one valid tenant key');
  const limits = driftLimits(config);
  const { data, error } = await admin
    .from('rag_drift_weekly')
    .select('week, divergence, null_p95, state, report')
    .eq('tenant_key', tenantKey)
    .order('week', { ascending: false })
    .limit(TREND_WEEKS);
  if (error) throw failure('read', error);
  const rows = (data ?? []) as WeeklyRow[];
  const latest = rows[0];
  if (!latest) return { week: null, divergence: null, null_p95: null, state: null, limits, trend: [], clusters: [] };
  const oldest = new Date(Date.parse(`${String(latest.week).slice(0, 10)}T00:00:00Z`) - (TREND_WEEKS - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
  const trend = rows
    .filter((row) => String(row.week).slice(0, 10) >= oldest)
    .map((row) => ({ week: weekLabelOf(String(row.week)), divergence: Number(row.divergence), state: row.state }));
  const report = latest.report ?? {};
  const clusters = [...(report.clusters ?? [])].sort((a, b) => b.production_share - a.production_share || (a.id < b.id ? -1 : 1));
  return {
    week: weekLabelOf(String(latest.week)),
    divergence: Number(latest.divergence),
    null_p95: latest.null_p95 === null ? null : Number(latest.null_p95),
    state: latest.state,
    limits,
    trend,
    clusters,
    ...(report.scores ? { scores: report.scores } : {}),
    ...(report.gaps && report.gaps.length > 0 ? { gaps: report.gaps } : {}),
    ...(report.rates && report.rates.length > 0 ? { rates: report.rates } : {}),
  };
}
