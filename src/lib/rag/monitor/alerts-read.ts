import type { SupabaseClient } from '@supabase/supabase-js';
import { MonitorAlertSchema, type MonitorAlert } from '@/lib/rag-eval/contracts.generated';
import { readFeedbackLoopConfig, type RetrievalLogLevel } from '@/lib/rag/feedback-loop/config';
import { monitorSettings } from './config';

export type AlertStatusFilter = 'open' | 'acknowledged' | 'resolved' | 'active' | 'all';
export type AlertStatus = MonitorAlert['status'];
type Severity = MonitorAlert['severity'];
type AdminClient = Pick<SupabaseClient, 'from' | 'rpc'>;

export interface MonitorSummary {
  enabled: boolean;
  last_run_day: string | null;
  last_run_at: string | null;
  log_level: RetrievalLogLevel;
  groups_checked: number | null;
  groups_insufficient: number | null;
}

export type ListAlertsResult =
  | { ok: true; alerts: MonitorAlert[]; counts: { open: number; acknowledged: number }; nextCursor: string | null; invalid: number }
  | { ok: false; reason: 'unavailable' | 'invalid_cursor' };

export type AlertForAdminResult =
  | { ok: true; alert: MonitorAlert }
  | { ok: false; reason: 'not_found' | 'unavailable' };

export const MAX_ALERTS_PAGE = 50;

const ALERT_COLUMNS =
  'id,tenant_key,rule,kind,language,day,window_days,severity,status,observed_count,observed_total,baseline_count,baseline_total,' +
  'observed_rate,baseline_rate,band,breakdown,companions,sample_trace_ids,config_changes,suggestion,delivered,dedup_key,' +
  'acknowledged_at,created_at,updated_at';
const RUN_COLUMNS = 'ran_at,day,groups_checked,groups_insufficient';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_ORDER: readonly AlertStatus[] = ['open', 'acknowledged', 'resolved'];
const SEVERITY_ORDER: readonly Severity[] = ['alert', 'warning'];

/** Ordered segments of the list: open before acknowledged before resolved, then alert before warning (UI-SPEC 6.7). */
function segmentsFor(filter: AlertStatusFilter): Array<{ status: AlertStatus; severity: Severity }> {
  const statuses: readonly AlertStatus[] =
    filter === 'all' ? STATUS_ORDER : filter === 'active' ? ['open', 'acknowledged'] : [filter];
  return statuses.flatMap((status) => SEVERITY_ORDER.map((severity) => ({ status, severity })));
}

interface Cursor {
  segment: number;
  day: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.segment, cursor.day, cursor.id]), 'utf8').toString('base64url');
}

function decodeCursor(raw: string, segments: number): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [segment, day, id] = value as unknown[];
    if (typeof segment !== 'number' || !Number.isInteger(segment) || segment < 0 || segment >= segments) return null;
    if (typeof day !== 'string' || !DAY_RE.test(day) || typeof id !== 'string' || !UUID_RE.test(id)) return null;
    return { segment, day, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Rebuilds the contract alert from a rag_monitor_alerts row (the inverse of toUpsertPayload); null when it fails the contract. */
export function alertFromRow(row: Record<string, unknown>): MonitorAlert | null {
  const companions = Object.entries(objectOf(row.companions)).map(([rule, entry]) => {
    const item = objectOf(entry);
    return { rule, value: numberOrNull(item.value), baseline: numberOrNull(item.baseline), n: item.n };
  });
  const parsed = MonitorAlertSchema.safeParse({
    id: row.id,
    tenant_key: row.tenant_key,
    rule: row.rule,
    kind: row.kind,
    language: row.language,
    day: typeof row.day === 'string' ? row.day.slice(0, 10) : row.day,
    window_days: row.window_days,
    severity: row.severity,
    status: row.status,
    observed: { count: row.observed_count, n: row.observed_total, value: numberOrNull(row.observed_rate) },
    baseline: { count: row.baseline_count, n: row.baseline_total, value: numberOrNull(row.baseline_rate) },
    band: objectOf(row.band),
    breakdown: objectOf(row.breakdown),
    companions,
    sample_trace_ids: Array.isArray(row.sample_trace_ids) ? row.sample_trace_ids : [],
    config_changes: Array.isArray(row.config_changes) ? row.config_changes : [],
    suggestion: row.suggestion ?? null,
    delivered: objectOf(row.delivered),
    dedup_key: row.dedup_key,
    acknowledged_at: isoOrNull(row.acknowledged_at),
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
  });
  return parsed.success ? parsed.data : null;
}

/** The tenants this admin administers, resolved in SQL by rag_admin_tenant_keys (service_role only). */
async function tenantKeys(admin: AdminClient, actor: string): Promise<string[] | null> {
  const { data, error } = await admin.rpc('rag_admin_tenant_keys', { p_actor: actor });
  if (error || !Array.isArray(data)) return null;
  return data.filter((key): key is string => typeof key === 'string');
}

async function countStatus(admin: AdminClient, keys: string[], status: AlertStatus): Promise<number | null> {
  const { count, error } = await admin
    .from('rag_monitor_alerts')
    .select('id', { count: 'exact', head: true })
    .in('tenant_key', keys)
    .eq('status', status);
  if (error || typeof count !== 'number') return null;
  return count;
}

/**
 * D-22, D-25, UI-SPEC 6.7 and 8.1: alerts of the tenants the verified admin administers, optionally one of them, filtered by
 * status and ordered open, acknowledged, resolved; alert before warning; newest day first (then id). Each page reads one ordered
 * segment after another with a keyset cursor. Every row is rebuilt into MonitorAlertSchema; a row that fails it is dropped and counted.
 */
export async function listAlerts(
  admin: AdminClient,
  input: { actorUserId: string; status: AlertStatusFilter; tenant?: string | null; limit: number; cursor?: string | null },
): Promise<ListAlertsResult> {
  if (!UUID_RE.test(input.actorUserId)) return { ok: false, reason: 'unavailable' };
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_ALERTS_PAGE);
  const segments = segmentsFor(input.status);
  let cursor: Cursor | null = null;
  if (input.cursor) {
    cursor = decodeCursor(input.cursor, segments.length);
    if (!cursor) return { ok: false, reason: 'invalid_cursor' };
  }

  const administered = await tenantKeys(admin, input.actorUserId.toLowerCase());
  if (!administered) return { ok: false, reason: 'unavailable' };
  const keys = input.tenant ? administered.filter((key) => key === input.tenant) : administered;
  if (keys.length === 0) return { ok: true, alerts: [], counts: { open: 0, acknowledged: 0 }, nextCursor: null, invalid: 0 };

  const [open, acknowledged] = await Promise.all([countStatus(admin, keys, 'open'), countStatus(admin, keys, 'acknowledged')]);
  if (open === null || acknowledged === null) return { ok: false, reason: 'unavailable' };

  const alerts: MonitorAlert[] = [];
  let invalid = 0;
  let last: Cursor | null = null;
  let more = false;
  for (let index = cursor?.segment ?? 0; index < segments.length && !more; index += 1) {
    const { status, severity } = segments[index];
    let query = admin
      .from('rag_monitor_alerts')
      .select(ALERT_COLUMNS)
      .in('tenant_key', keys)
      .eq('status', status)
      .eq('severity', severity);
    if (cursor && cursor.segment === index) query = query.or(`day.lt.${cursor.day},and(day.eq.${cursor.day},id.lt.${cursor.id})`);
    const { data, error } = await query
      .order('day', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit - (alerts.length + invalid) + 1);
    if (error || !Array.isArray(data)) return { ok: false, reason: 'unavailable' };
    for (const row of data as unknown as Array<Record<string, unknown>>) {
      if (alerts.length + invalid >= limit) {
        more = true;
        break;
      }
      last = { segment: index, day: String(row.day).slice(0, 10), id: String(row.id).toLowerCase() };
      const alert = alertFromRow(row);
      if (alert) alerts.push(alert);
      else invalid += 1;
    }
  }
  return { ok: true, alerts, counts: { open, acknowledged }, nextCursor: more && last ? encodeCursor(last) : null, invalid };
}

/** One alert by id, only when its tenant is one the verified admin administers; another tenant's alert reads as not found. */
export async function alertForAdmin(admin: AdminClient, actorUserId: string, id: string): Promise<AlertForAdminResult> {
  if (!UUID_RE.test(actorUserId) || !UUID_RE.test(id)) return { ok: false, reason: 'not_found' };
  const keys = await tenantKeys(admin, actorUserId.toLowerCase());
  if (!keys) return { ok: false, reason: 'unavailable' };
  const { data, error } = await admin.from('rag_monitor_alerts').select(ALERT_COLUMNS).eq('id', id.toLowerCase()).limit(1);
  if (error || !Array.isArray(data)) return { ok: false, reason: 'unavailable' };
  const row = (data as unknown as Array<Record<string, unknown>>)[0];
  if (!row || typeof row.tenant_key !== 'string' || !keys.includes(row.tenant_key)) return { ok: false, reason: 'not_found' };
  const alert = alertFromRow(row);
  if (!alert) return { ok: false, reason: 'unavailable' };
  return { ok: true, alert };
}

/** The summary of UI-SPEC 6.7: switch state, configured retrieval log level and the newest rag_monitor_runs row (nulls when none). */
export async function monitorSummary(
  admin: Pick<SupabaseClient, 'from'>,
  source: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; monitor: MonitorSummary } | { ok: false; reason: 'unavailable' }> {
  const { data, error } = await admin.from('rag_monitor_runs').select(RUN_COLUMNS).order('ran_at', { ascending: false }).limit(1);
  if (error || !Array.isArray(data)) return { ok: false, reason: 'unavailable' };
  const run = (data as unknown as Array<Record<string, unknown>>)[0];
  return {
    ok: true,
    monitor: {
      enabled: monitorSettings().monitor,
      last_run_day: run && typeof run.day === 'string' ? run.day.slice(0, 10) : null,
      last_run_at: run ? isoOrNull(run.ran_at) : null,
      log_level: readFeedbackLoopConfig(source, () => {}).retrievalLog,
      groups_checked: run ? numberOrNull(run.groups_checked) : null,
      groups_insufficient: run ? numberOrNull(run.groups_insufficient) : null,
    },
  };
}
