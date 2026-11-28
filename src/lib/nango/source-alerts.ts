import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { upsertAlerts } from '@/lib/rag/monitor/alerts-store';
import { monitorSettings, type MonitorEnvInput } from '@/lib/rag/monitor/config';
import type { AlertCandidate } from '@/lib/rag/monitor/rule-registry';

/** What a source alert reports (D-09, D-10); each is a value nango_connections.last_reconcile_status accepts (0720). */
export type SourceAlertKind = 'paused' | 'overdue' | 'failed' | 'incomplete';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

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

function codeOf(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
}

async function ownerUserId(admin: SupabaseAdmin, connection: { id: string; user_id?: string | null }): Promise<string | null> {
    if (typeof connection.user_id === 'string' && connection.user_id !== '') return connection.user_id;
    const { data, error } = await admin.from('nango_connections').select('user_id').eq('id', connection.id).maybeSingle();
    if (error) return null;
    const userId = (data as { user_id?: unknown } | null)?.user_id;
    return typeof userId === 'string' && userId !== '' ? userId : null;
}

/**
 * The OBS-03 alert of D-10 (Phase 6.3 G2): one source_sync alert per (tenant, kind, connection), deduplicated by a hash, with
 * counts only. The tenant is the connection owner's, resolved in SQL (rag_nango_owner_tenant_key). Returns false when nothing
 * was stored; never throws.
 */
async function storeMonitorAlert(
    admin: SupabaseAdmin,
    connection: { id: string; user_id?: string | null },
    kind: SourceAlertKind,
    counts: Record<string, number>,
    webhookUrl: string | null,
    now: Date
): Promise<boolean> {
    try {
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
            admin as never,
            [{ candidate, evidence: { sampleTraceIds: [], configChanges: [] }, channels: webhookUrl ? ['webhook'] : [] }],
            now
        );
        return stored.ids.length > 0;
    } catch (error) {
        logger.warn('Source Reconcile', 'Source alert not stored as a monitor alert', { connectionId: connection.id, code: codeOf(error) });
        return false;
    }
}

/**
 * The thin alert adapter of D-10. The alert is always recorded on the connection row (`last_reconcile_status`) and logged with
 * ids and counts only. With RAG_MONITOR on it is also written to the OBS-03 store (`rag_monitor_alerts`, `upsertAlerts`, rule
 * source_reconcile_<kind>, kind source_sync), which delivers it like any monitor alert. With RAG_MONITOR off nothing else happens.
 */
export async function raiseSourceAlert(
    connection: { id: string; user_id?: string | null },
    kind: SourceAlertKind,
    counts: Record<string, number>,
    options: { admin?: SupabaseAdmin; env?: MonitorEnvInput; now?: Date } = {}
): Promise<'connection_status' | 'monitor_alert'> {
    logger.warn('Source Reconcile', `Source alert: ${kind}`, { connectionId: connection.id, ...counts });
    const admin = options.admin ?? getSupabaseAdmin();
    if (!admin || connection.id === '') return 'connection_status';
    try {
        const { error } = await admin.from('nango_connections').update({ last_reconcile_status: kind }).eq('id', connection.id);
        if (error) {
            logger.warn('Source Reconcile', 'Alert state not stored on the connection', {
                connectionId: connection.id,
                code: (error as { code?: string }).code ?? null,
            });
        }
    } catch (error) {
        logger.warn('Source Reconcile', 'Alert state not stored on the connection', {
            connectionId: connection.id,
            code: (error as { code?: string } | null)?.code ?? null,
        });
    }
    const settings = options.env ? monitorSettings(options.env) : monitorSettings();
    if (!settings.monitor) return 'connection_status';
    const stored = await storeMonitorAlert(admin, connection, kind, counts, settings.webhookUrl, options.now ?? new Date());
    return stored ? 'monitor_alert' : 'connection_status';
}
