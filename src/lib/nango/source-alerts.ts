import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';

/** What a source alert reports (D-09, D-10); each is a value nango_connections.last_reconcile_status accepts (0720). */
export type SourceAlertKind = 'paused' | 'overdue' | 'failed' | 'incomplete';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/**
 * The thin alert adapter of D-10. The OBS-03 store of Phase 5.3 (`rag_monitor_alerts`, `upsertAlerts`) is on trunk,
 * but its rule and kind vocabularies (CHECK constraints in 0963 and the MonitorAlert contract) have no source-sync rule,
 * so a source alert cannot be written there without a migration and a contract change. Until that lands the alert is
 * recorded on the connection row (`last_reconcile_status`) and logged with ids and counts only.
 */
export async function raiseSourceAlert(
    connection: { id: string },
    kind: SourceAlertKind,
    counts: Record<string, number>,
    options: { admin?: SupabaseAdmin } = {}
): Promise<'connection_status'> {
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
    return 'connection_status';
}
