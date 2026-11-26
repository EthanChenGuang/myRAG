import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MonitorAlertSchema, type MonitorAlert } from '@/lib/rag-eval/contracts.generated';
import { assertPublicUrl, type BackfillSourceDeps } from '../ingest/backfill/sources';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from '../trace/config';
import { postLangfuseScores } from '../trace/scores';
import type { DeliveryChannel, DeliveryState } from './alerts-store';
import { MIN_WEBHOOK_SECRET_LENGTH, monitorSettings, type MonitorSettings } from './config';

export const WEBHOOK_SIGNATURE_HEADER = 'x-myrag-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-myrag-timestamp';
export const LANGFUSE_ALERT_SCORE = 'rag_monitor_alert';
/** A channel that failed this many times is left failed (D-26). */
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['webhook', 'langfuse'];

export type DeliveredMap = NonNullable<MonitorAlert['delivered']>;
export type ChannelDelivery = DeliveredMap[string];

export interface DeliveryReport {
  alertId: string;
  /** The Config UI banner reads stored alerts, so a stored alert is delivered there. */
  banner: { status: 'delivered'; at: string };
  delivered: DeliveredMap;
  /** Channels attempted by this call (a request was made or refused by the URL guard). */
  attempted: DeliveryChannel[];
}

export interface DeliverDeps {
  settings?: MonitorSettings;
  fetch?: typeof fetch;
  lookupHost?: BackfillSourceDeps['lookupHost'];
  now?: Date;
  langfuse?: LangfuseConfig;
  timeoutMs?: number;
}

export type ChannelCounts = Record<DeliveryState, number>;

export interface StoredDeliverySummary {
  alerts: number;
  attempted: number;
  banner: number;
  channels: Record<DeliveryChannel, ChannelCounts>;
  writeFailures: number;
}

const ALERT_COLUMNS = [
  'id',
  'tenant_key',
  'rule',
  'kind',
  'language',
  'day',
  'window_days',
  'severity',
  'status',
  'observed_count',
  'observed_total',
  'observed_rate',
  'baseline_count',
  'baseline_total',
  'baseline_rate',
  'band',
  'breakdown',
  'companions',
  'sample_trace_ids',
  'config_changes',
  'suggestion',
  'delivered',
  'dedup_key',
  'acknowledged_at',
  'created_at',
  'updated_at',
].join(', ');
const PAGE = 200;
const MAX_ROWS_SCANNED = 2000;

/** `sha256=<hex>` of HMAC-SHA256(secret, "<timestamp>.<body>"); the receiver recomputes it over the raw body. */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function needsAttempt(entry: ChannelDelivery | undefined): boolean {
  if (!entry) return true;
  if (entry.state === 'pending') return true;
  return entry.state === 'failed' && entry.attempts < MAX_DELIVERY_ATTEMPTS;
}

function settled(state: DeliveryState, attempts: number, at: string): ChannelDelivery {
  return { state, attempts, last_attempt_at: at };
}

async function sendWebhook(alert: MonitorAlert, settings: MonitorSettings, deps: DeliverDeps, now: Date, timeoutMs: number): Promise<'delivered' | 'failed'> {
  const body = JSON.stringify(alert);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/json', [WEBHOOK_TIMESTAMP_HEADER]: timestamp };
  const secret = settings.webhookSecret;
  if (secret && secret.length >= MIN_WEBHOOK_SECRET_LENGTH) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, timestamp, body);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const url = new URL(settings.webhookUrl as string);
    await assertPublicUrl(url, deps.lookupHost, signal);
    const response = await (deps.fetch ?? fetch)(url.toString(), { method: 'POST', headers, body, redirect: 'manual', signal });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300 ? 'delivered' : 'failed';
  } catch {
    return 'failed';
  }
}

async function sendLangfuse(alert: MonitorAlert, langfuse: LangfuseConfig, deps: DeliverDeps, timeoutMs: number): Promise<DeliveryState> {
  const traces = alert.sample_trace_ids ?? [];
  if (traces.length === 0) return 'disabled';
  const result = await postLangfuseScores(
    traces.map((traceId) => ({
      traceId,
      name: LANGFUSE_ALERT_SCORE,
      value: 1,
      dataType: 'NUMERIC' as const,
      metadata: { alert_id: alert.id, rule: alert.rule, severity: alert.severity },
    })),
    { config: langfuse, fetch: deps.fetch, timeoutMs },
  );
  if (result.status === 'accepted') return 'delivered';
  if (result.status === 'skipped') return 'disabled';
  return 'failed';
}

/**
 * D-26: delivers each alert to the banner (stored), the admin webhook and Langfuse. A channel that is delivered or disabled,
 * or that failed MAX_DELIVERY_ATTEMPTS times, is not tried again; a pending, failed or never-tried channel is. The webhook
 * runs only for an https URL that passes the outbound guard on every delivery, with redirects refused; Langfuse only when
 * it is usable and the alert has sample traces. Never throws. Logs carry the alert id, channel and state only.
 */
export async function deliverAlerts(alerts: readonly MonitorAlert[], deps: DeliverDeps = {}): Promise<DeliveryReport[]> {
  const settings = deps.settings ?? monitorSettings();
  const langfuse = deps.langfuse ?? readLangfuseConfig();
  const langfuseUsable = isLangfuseUsable(langfuse);
  const now = deps.now ?? new Date();
  const at = now.toISOString();
  const timeoutMs = deps.timeoutMs !== undefined && deps.timeoutMs > 0 ? deps.timeoutMs : DELIVERY_TIMEOUT_MS;
  const reports: DeliveryReport[] = [];

  for (const alert of alerts) {
    const delivered: DeliveredMap = { ...(alert.delivered ?? {}) };
    const attempted: DeliveryChannel[] = [];
    for (const channel of DELIVERY_CHANNELS) {
      const previous = delivered[channel];
      if (!needsAttempt(previous)) continue;
      const attempts = previous?.attempts ?? 0;
      let next: ChannelDelivery;
      if (channel === 'webhook') {
        if (!settings.webhookUrl) {
          next = settled('disabled', attempts, at);
        } else {
          attempted.push(channel);
          next = settled(await sendWebhook(alert, settings, deps, now, timeoutMs), attempts + 1, at);
        }
      } else if (!langfuseUsable || (alert.sample_trace_ids ?? []).length === 0) {
        next = settled('disabled', attempts, at);
      } else {
        attempted.push(channel);
        const state = await sendLangfuse(alert, langfuse, deps, timeoutMs);
        next = settled(state, state === 'disabled' ? attempts : attempts + 1, at);
      }
      delivered[channel] = next;
      if (next.state === 'failed') console.warn('[Monitor] alert delivery failed', { alertId: alert.id, channel, attempts: next.attempts });
    }
    reports.push({ alertId: alert.id, banner: { status: 'delivered', at }, delivered, attempted });
  }
  return reports;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A rag_monitor_alerts row (0963 layout) as the MonitorAlert contract; null when the row does not satisfy it. */
export function fromAlertRow(row: Record<string, unknown>): MonitorAlert | null {
  const companions = row.companions && typeof row.companions === 'object' && !Array.isArray(row.companions) ? (row.companions as Record<string, Record<string, unknown>>) : {};
  const baselineCount = Number(row.baseline_count ?? 0);
  const baselineTotal = Number(row.baseline_total ?? 0);
  const baselineRate = numberOrNull(row.baseline_rate);
  const parsed = MonitorAlertSchema.safeParse({
    id: row.id,
    tenant_key: row.tenant_key,
    rule: row.rule,
    kind: row.kind,
    language: row.language,
    day: String(row.day instanceof Date ? row.day.toISOString() : row.day).slice(0, 10),
    window_days: row.window_days,
    severity: row.severity,
    status: row.status,
    observed: { count: Number(row.observed_count ?? 0), n: Number(row.observed_total ?? 0), value: numberOrNull(row.observed_rate) },
    baseline: baselineCount === 0 && baselineTotal === 0 && baselineRate === null ? null : { count: baselineCount, n: baselineTotal, value: baselineRate },
    band: row.band ?? {},
    breakdown: row.breakdown ?? {},
    companions: Object.entries(companions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, entry]) => ({ rule, value: numberOrNull(entry?.value), baseline: numberOrNull(entry?.baseline), n: Number(entry?.n ?? 0) })),
    sample_trace_ids: Array.isArray(row.sample_trace_ids) ? row.sample_trace_ids : [],
    config_changes: Array.isArray(row.config_changes) ? row.config_changes : [],
    suggestion: row.suggestion ?? null,
    delivered: row.delivered && typeof row.delivered === 'object' ? row.delivered : {},
    dedup_key: row.dedup_key,
    acknowledged_at: isoOrNull(row.acknowledged_at),
    created_at: isoOrNull(row.created_at),
    updated_at: isoOrNull(row.updated_at),
  });
  return parsed.success ? parsed.data : null;
}

function emptyCounts(): ChannelCounts {
  return { pending: 0, delivered: 0, failed: 0, disabled: 0 };
}

/** Non-resolved alerts with a channel still to try, oldest day first, read page by page. */
async function alertsToDeliver(admin: SupabaseClient): Promise<MonitorAlert[]> {
  const out: MonitorAlert[] = [];
  for (let offset = 0; offset < MAX_ROWS_SCANNED; offset += PAGE) {
    const { data, error } = await admin
      .from('rag_monitor_alerts')
      .select(ALERT_COLUMNS)
      .neq('status', 'resolved')
      .order('day', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error('[Monitor] read alerts for delivery failed');
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const alert = fromAlertRow(row);
      if (!alert) {
        console.warn('[Monitor] stored alert failed the contract; not delivered', { alertId: typeof row.id === 'string' ? row.id : null });
        continue;
      }
      if (DELIVERY_CHANNELS.some((channel) => needsAttempt(alert.delivered?.[channel]))) out.push(alert);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * The delivery step of the daily run: reads stored alerts that still have a channel to try, delivers them and writes each
 * alert's delivered map back. A failed write is counted and the next run retries the delivery.
 */
export async function deliverStoredAlerts(admin: SupabaseClient, deps: DeliverDeps = {}): Promise<StoredDeliverySummary> {
  const alerts = await alertsToDeliver(admin);
  const reports = await deliverAlerts(alerts, deps);
  const summary: StoredDeliverySummary = {
    alerts: reports.length,
    attempted: 0,
    banner: reports.length,
    channels: { webhook: emptyCounts(), langfuse: emptyCounts() },
    writeFailures: 0,
  };
  for (const report of reports) {
    summary.attempted += report.attempted.length;
    for (const channel of DELIVERY_CHANNELS) {
      const entry = report.delivered[channel];
      if (entry) summary.channels[channel][entry.state] += 1;
    }
    const { error } = await admin.from('rag_monitor_alerts').update({ delivered: report.delivered }).eq('id', report.alertId).neq('status', 'resolved');
    if (error) {
      summary.writeFailures += 1;
      console.warn('[Monitor] delivery state not stored', { alertId: report.alertId });
    }
  }
  console.info('[Monitor] delivery finished', {
    alerts: summary.alerts,
    attempted: summary.attempted,
    webhook: summary.channels.webhook,
    langfuse: summary.channels.langfuse,
    write_failures: summary.writeFailures,
  });
  return summary;
}
