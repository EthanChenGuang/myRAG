import { getSupabaseAdmin } from '@/lib/supabase';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/** What a source alert reports (D-09, D-10); each is a value nango_connections.last_reconcile_status accepts (0720). */
export type SourceAlertKind = 'paused' | 'overdue' | 'failed' | 'incomplete';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The Phase 5.3 switches this adapter reads; tests pass their own, production reads src/lib/env.ts. */
type MonitorEnv = { RAG_MONITOR?: string; RAG_MONITOR_WEBHOOK_URL?: string; RAG_MONITOR_WEBHOOK_SECRET?: string };

function codeOf(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
}

/**
 * The thin alert adapter of D-10. The alert is always recorded on the connection row (`last_reconcile_status`) and logged with
 * ids and counts only. With RAG_MONITOR on it is also written to the OBS-03 store (`rag_monitor_alerts` through upsertAlerts:
 * rule source_reconcile_<kind>, kind source_sync), which delivers it like any monitor alert; the monitor code is loaded only
 * then. With RAG_MONITOR off nothing else happens.
 */
export async function raiseSourceAlert(
    connection: { id: string; user_id?: string | null },
    kind: SourceAlertKind,
    counts: Record<string, number>,
    options: { admin?: SupabaseAdmin; env?: MonitorEnv; now?: Date } = {}
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
    const switches: MonitorEnv = options.env ?? env;
    if (String(switches.RAG_MONITOR ?? '').trim().toLowerCase() !== 'true') return 'connection_status';
    try {
        const { storeSourceMonitorAlert } = await import('@/lib/rag');
        const stored = await storeSourceMonitorAlert(admin as never, connection, kind, counts, { env: switches, now: options.now });
        return stored ? 'monitor_alert' : 'connection_status';
    } catch (error) {
        logger.warn('Source Reconcile', 'Source alert not stored as a monitor alert', { connectionId: connection.id, code: codeOf(error) });
        return 'connection_status';
    }
}
