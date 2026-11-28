import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { upsertAlerts } from './alerts-store';
import { monitorSettings, type MonitorEnvInput } from './config';
import type { AlertCandidate } from './rule-registry';

/** What a source alert reports (D-09, D-10); each is a value nango_connections.last_reconcile_status accepts (0720). */
export type SourceAlertKind = 'paused' | 'overdue' | 'failed' | 'incomplete';

const SEVERITY: Record<SourceAlertKind, 'warning' | 'alert'> = {
  paused: 'alert',
  failed: 'alert',
  overdue: 'warning',
  incomplete: 'warning',
};
/** Which count is the observed number and which is its reference (total, cap or age limit), by the callers' keys. */
const COUNT_KEYS = ['candidates', 'held', 'days'] as const;
const TOTAL_KEYS = ['total', 'cap', 'limit'] as const;

function firstCount(counts: Record<string, number>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = counts[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return 0;
}

async function ownerUserId(admin: SupabaseClient, connection: { id: string; user_id?: string | null }): Promise<string | null> {
  if (typeof connection.user_id === 'string' && connection.user_id !== '') return connection.user_id;
  const { data, error } = await admin.from('nango_connections').select('user_id').eq('id', connection.id).maybeSingle();
  if (error) return null;
  const userId = (data as { user_id?: unknown } | null)?.user_id;
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

/**
 * The OBS-03 side of D-10 (Phase 6.3 G2): one source_sync alert per (tenant, kind, connection) in rag_monitor_alerts through
 * upsertAlerts, deduplicated by a hash, counts only. The tenant is the connection owner's, resolved in SQL
 * (rag_nango_owner_tenant_key). Writes nothing while RAG_MONITOR is off. Returns true when an alert row was stored; throws
 * on a store error (the caller decides how to log it).
 */
export async function storeSourceMonitorAlert(
  admin: SupabaseClient,
  connection: { id: string; user_id?: string | null },
  kind: SourceAlertKind,
  counts: Record<string, number>,
  options: { env?: MonitorEnvInput; now?: Date } = {},
): Promise<boolean> {
  const settings = options.env ? monitorSettings(options.env) : monitorSettings();
  if (!settings.monitor) return false;
  const now = options.now ?? new Date();
  const userId = await ownerUserId(admin, connection);
  if (!userId) return false;
  const { data: tenantKey, error } = await admin.rpc('rag_nango_owner_tenant_key', { p_user_id: userId });
  if (error || typeof tenantKey !== 'string' || tenantKey === '') return false;
  const rule = `source_reconcile_${kind}` as const;
  const candidate: AlertCandidate = {
    tenant_key: tenantKey,
    rule,
    kind: 'source_sync',
    language: 'all',
    day: now.toISOString().slice(0, 10),
    window_days: 1,
    severity: SEVERITY[kind],
    observed: { count: firstCount(counts, COUNT_KEYS), n: firstCount(counts, TOTAL_KEYS), value: null },
    baseline: null,
    band: {},
    breakdown: {},
    companions: [],
    cluster_ids: [],
    suggestion: null,
    dedup_key: createHash('sha256').update(`${tenantKey}|all|${rule}|${connection.id}`, 'utf8').digest('hex'),
  };
  const stored = await upsertAlerts(
    admin,
    [{ candidate, evidence: { sampleTraceIds: [], configChanges: [] }, channels: settings.webhookUrl ? ['webhook'] : [] }],
    now,
  );
  return stored.ids.length > 0;
}
