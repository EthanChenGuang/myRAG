import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MonitorAlertSchema, type MonitorAlert } from '@/lib/rag-eval/contracts.generated';
import type { AlertCandidate } from './rule-registry';

export type DeliveryChannel = 'webhook' | 'langfuse';
export type DeliveryState = 'pending' | 'delivered' | 'failed' | 'disabled';
export type ConfigChange = NonNullable<MonitorAlert['config_changes']>[number];

export interface AlertEvidence {
  sampleTraceIds: string[];
  configChanges: ConfigChange[];
}

export interface UpsertAlertInput {
  candidate: AlertCandidate;
  evidence: AlertEvidence;
  /** Delivery channels queued when the alert is new; an update keeps the delivery state already stored. */
  channels: readonly DeliveryChannel[];
}

export type UpsertOutcome = 'opened' | 'updated' | 'suppressed' | 'invalid';

export interface UpsertAlertsResult {
  opened: number;
  updated: number;
  suppressed: number;
  invalid: number;
  /** Channel deliveries queued as pending by this call. */
  deliveries: number;
  ids: string[];
}

export interface RunRecord {
  day: string;
  source: 'cli' | 'route' | 'schedule';
  daysAggregated: number;
  groupsChecked: number;
  groupsInsufficient: number;
  alertsOpened: number;
  alertsUpdated: number;
  deliveries: number;
}

export interface PendingDelivery {
  id: string;
  tenantKey: string;
  rule: string;
  day: string;
  channels: DeliveryChannel[];
}

const MAX_CONFIG_CHANGES = 50;

export class MonitorStoreError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`[Monitor] ${operation} failed${code ? ` (${code})` : ''}`);
    this.name = 'MonitorStoreError';
  }
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** The contract row a candidate becomes; validated before anything is written (no free text can pass the schema). */
export function toMonitorAlert(
  candidate: AlertCandidate,
  evidence: AlertEvidence,
  delivered: MonitorAlert['delivered'],
  now: Date,
): MonitorAlert | null {
  const stamp = now.toISOString();
  const parsed = MonitorAlertSchema.safeParse({
    ...candidate,
    id: randomUUID(),
    status: 'open',
    sample_trace_ids: evidence.sampleTraceIds.slice(0, 10),
    config_changes: evidence.configChanges.slice(0, MAX_CONFIG_CHANGES),
    delivered,
    acknowledged_at: null,
    created_at: stamp,
    updated_at: stamp,
  });
  if (!parsed.success) {
    console.warn('[Monitor] alert candidate failed the contract; not stored', {
      rule: candidate.rule,
      issues: parsed.error.issues.length,
    });
    return null;
  }
  return parsed.data;
}

/** The rag_monitor_alert_upsert payload: observed and baseline become count, total and rate columns; companions an object by rule. */
export function toUpsertPayload(alert: MonitorAlert): Record<string, unknown> {
  const companions: Record<string, { value: number | null; baseline: number | null; n: number }> = {};
  for (const companion of alert.companions ?? []) {
    companions[companion.rule] = { value: companion.value, baseline: companion.baseline, n: companion.n };
  }
  return {
    tenant_key: alert.tenant_key,
    rule: alert.rule,
    kind: alert.kind,
    language: alert.language,
    day: alert.day,
    window_days: alert.window_days,
    severity: alert.severity,
    observed_count: alert.observed.count ?? 0,
    observed_total: alert.observed.n,
    observed_rate: alert.observed.value,
    baseline_count: alert.baseline?.count ?? 0,
    baseline_total: alert.baseline?.n ?? 0,
    baseline_rate: alert.baseline?.value ?? null,
    band: alert.band,
    breakdown: alert.breakdown ?? {},
    companions,
    sample_trace_ids: alert.sample_trace_ids ?? [],
    config_changes: alert.config_changes ?? [],
    suggestion: alert.suggestion,
    delivered: alert.delivered ?? {},
    dedup_key: alert.dedup_key,
  };
}

async function openAlertId(admin: SupabaseClient, tenantKey: string, dedupKey: string): Promise<string | null> {
  const { data, error } = await admin
    .from('rag_monitor_alerts')
    .select('id')
    .eq('tenant_key', tenantKey)
    .eq('dedup_key', dedupKey)
    .neq('status', 'resolved')
    .limit(1);
  if (error) throw new MonitorStoreError('read_open_alert', codeOf(error));
  const rows = (data ?? []) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Stores candidates through rag_monitor_alert_upsert, one open alert per (tenant, dedup_key) (D-25). A new alert queues each
 * channel as pending; an update leaves the stored delivery state alone. A NULL id means a resolved alert of the same or a later
 * day suppressed the candidate: nothing raised, nothing to deliver.
 */
export async function upsertAlerts(
  admin: SupabaseClient,
  inputs: readonly UpsertAlertInput[],
  now: Date = new Date(),
): Promise<UpsertAlertsResult> {
  const result: UpsertAlertsResult = { opened: 0, updated: 0, suppressed: 0, invalid: 0, deliveries: 0, ids: [] };
  for (const input of inputs) {
    const existing = await openAlertId(admin, input.candidate.tenant_key, input.candidate.dedup_key);
    const delivered: MonitorAlert['delivered'] = {};
    if (!existing) {
      for (const channel of input.channels) delivered[channel] = { state: 'pending', attempts: 0, last_attempt_at: null };
    }
    const alert = toMonitorAlert(input.candidate, input.evidence, delivered, now);
    if (!alert) {
      result.invalid += 1;
      continue;
    }
    const { data, error } = await admin.rpc('rag_monitor_alert_upsert', { p_alert: toUpsertPayload(alert) });
    if (error) throw new MonitorStoreError('rag_monitor_alert_upsert', codeOf(error));
    const id = typeof data === 'string' ? data : null;
    if (!id) {
      result.suppressed += 1;
      continue;
    }
    result.ids.push(id);
    if (existing) {
      result.updated += 1;
    } else {
      result.opened += 1;
      result.deliveries += Object.keys(delivered).length;
    }
  }
  return result;
}

/** open -> acknowledged, open or acknowledged -> resolved; false for any other transition. */
export async function setAlertStatus(
  admin: SupabaseClient,
  id: string,
  status: 'acknowledged' | 'resolved',
  actor: string | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc('rag_monitor_alert_set_status', { p_id: id, p_status: status, p_actor: actor });
  if (error) throw new MonitorStoreError('rag_monitor_alert_set_status', codeOf(error));
  return data === true;
}

/** Non-resolved alerts with a channel still pending or failed, for the delivery step; ids and codes only. */
export async function pendingDeliveries(admin: SupabaseClient, limit = 200): Promise<PendingDelivery[]> {
  const { data, error } = await admin
    .from('rag_monitor_alerts')
    .select('id, tenant_key, rule, day, delivered')
    .neq('status', 'resolved')
    .order('day', { ascending: true })
    .limit(limit);
  if (error) throw new MonitorStoreError('read_pending_deliveries', codeOf(error));
  const out: PendingDelivery[] = [];
  for (const row of (data ?? []) as Array<{ id: string; tenant_key: string; rule: string; day: string; delivered: unknown }>) {
    const delivered = row.delivered && typeof row.delivered === 'object' ? (row.delivered as Record<string, { state?: string }>) : {};
    const channels = Object.entries(delivered)
      .filter(([, entry]) => entry?.state === 'pending' || entry?.state === 'failed')
      .map(([channel]) => channel as DeliveryChannel)
      .sort();
    if (channels.length > 0) {
      out.push({ id: row.id, tenantKey: row.tenant_key, rule: row.rule, day: String(row.day).slice(0, 10), channels });
    }
  }
  return out;
}

/** Inserts one rag_monitor_runs row with the run's counts. */
export async function recordRun(admin: SupabaseClient, run: RunRecord): Promise<void> {
  const { error } = await admin.from('rag_monitor_runs').insert({
    day: run.day,
    source: run.source,
    days_aggregated: run.daysAggregated,
    groups_checked: run.groupsChecked,
    groups_insufficient: run.groupsInsufficient,
    alerts_opened: run.alertsOpened,
    alerts_updated: run.alertsUpdated,
    deliveries: run.deliveries,
  });
  if (error) throw new MonitorStoreError('record_run', codeOf(error));
}

/** Deletes run rows older than keepDays (the 400-day window of the daily cells). */
export async function purgeRuns(admin: SupabaseClient, now: Date, keepDays = 400): Promise<void> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000).toISOString();
  const { error } = await admin.from('rag_monitor_runs').delete().lt('ran_at', cutoff);
  if (error) throw new MonitorStoreError('purge_runs', codeOf(error));
}
