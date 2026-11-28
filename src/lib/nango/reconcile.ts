import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { listConnectionFiles, removeOrphans, type ListableConnectionRow } from './sync-manager';
import { connectionTenantKey, recordReconcileRun } from './source-deletions';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const SOURCE_RECONCILE = 'Source Reconcile';
const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 3650;

/** The nango_connections columns the scheduled reconcile reads (0720 adds the reconcile fields). */
export interface ReconcileConnectionRow extends ListableConnectionRow {
    status?: string | null;
    connected_at?: string | null;
    last_full_reconcile_at?: string | null;
    last_reconcile_status?: string | null;
}

const CONNECTION_COLUMNS =
    'id, connection_id, user_id, provider, deletion_mode, status, connected_at, last_full_reconcile_at, last_reconcile_status, sync_folder_id, sync_file_ids';

export interface SourceReconcileDeps {
    /** The canary passes a PGlite admin; the CLI and the route never pass it. */
    admin?: SupabaseAdmin;
    /** The canary passes the fake connector; defaults to listConnectionFiles. */
    listFiles?: (connection: ReconcileConnectionRow) => Promise<{ fileIds: string[]; complete: boolean }>;
}

export interface SourceReconcileOptions {
    /** How long the run may take, in milliseconds; no connection is started after it. */
    deadlineMs: number;
    /** Limits the run to this nango_connections.id. It is a filter, never an authority. */
    connectionId?: string;
    signal?: AbortSignal;
    /** Clock in epoch milliseconds (tests). */
    now?: () => number;
    deps?: SourceReconcileDeps;
}

export interface SourceReconcileResult {
    /** Connections whose listing was attempted. */
    processed: number;
    /** Documents removed. */
    removed: number;
    /** Listings whose removal paused for confirmation (D-09). */
    paused: number;
    /** Listings that were cut short; nothing removed. */
    incomplete: number;
    /** Listings or removals that failed; nothing removed by a failed listing. */
    failed: number;
    /** Due connections not started because the deadline passed or the run was aborted. */
    skipped: number;
    /** Overdue alerts raised (D-10, D-39). */
    overdue: number;
}

/** A database read failed; the CLI exits 1 and the route answers 503. */
export class SourceReconcileDatabaseError extends Error {
    readonly code: string | null;
    constructor(code: string | null) {
        super('source_reconcile_database_error');
        this.name = 'SourceReconcileDatabaseError';
        this.code = code;
    }
}

const warnedDays = new Set<string>();

/** A number of days above 0 and at most 3650; anything else is 7. */
export function parseReconcileDays(raw: string | undefined): number {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const value = trimmed === '' ? Number.NaN : Number(trimmed);
    return Number.isFinite(value) && value > 0 && value <= MAX_DAYS ? value : DEFAULT_DAYS;
}

function configuredDays(name: 'RAG_SOURCE_RECONCILE_INTERVAL_DAYS' | 'RAG_SOURCE_RECONCILE_MAX_AGE_DAYS'): number {
    const raw = env[name] as string | undefined;
    const days = parseReconcileDays(raw);
    if (!warnedDays.has(name) && raw !== undefined && raw.trim() !== '' && Number(raw) !== days) {
        warnedDays.add(name);
        logger.warn('RAG Config', `${name} is not a number of days in (0, ${MAX_DAYS}]; using ${DEFAULT_DAYS}`);
    }
    return days;
}

function timeOf(value: string | null | undefined): number | null {
    if (typeof value !== 'string' || value === '') return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function errorCode(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
}

async function loadConnections(admin: SupabaseAdmin, connectionId: string | undefined): Promise<ReconcileConnectionRow[]> {
    let query = admin.from('nango_connections').select(CONNECTION_COLUMNS).eq('status', 'connected');
    if (connectionId !== undefined) query = query.eq('id', connectionId);
    const { data, error } = await query;
    if (error) {
        logger.error(SOURCE_RECONCILE, 'Connections not read', { code: errorCode(error) });
        throw new SourceReconcileDatabaseError(errorCode(error));
    }
    return ((data ?? []) as ReconcileConnectionRow[]).filter(
        (row) => typeof row.id === 'string' && typeof row.user_id === 'string' && row.user_id !== '' && row.status === 'connected'
    );
}

/** Due: never fully reconciled, or the last completed reconcile is at least the interval old. NULL first, then oldest. */
export function dueConnections(rows: readonly ReconcileConnectionRow[], nowMs: number, intervalDays: number): ReconcileConnectionRow[] {
    const intervalMs = intervalDays * DAY_MS;
    return rows
        .filter((row) => {
            const last = timeOf(row.last_full_reconcile_at);
            return last === null || nowMs - last >= intervalMs;
        })
        .sort((a, b) => {
            const left = timeOf(a.last_full_reconcile_at);
            const right = timeOf(b.last_full_reconcile_at);
            if (left === null && right === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
            if (left === null) return -1;
            if (right === null) return 1;
            return left - right;
        });
}

async function reconcileOne(
    admin: SupabaseAdmin,
    row: ReconcileConnectionRow,
    listFiles: NonNullable<SourceReconcileDeps['listFiles']>,
    result: SourceReconcileResult
): Promise<void> {
    const tenantKey = connectionTenantKey(row);
    let listing: { fileIds: string[]; complete: boolean };
    try {
        listing = await listFiles(row);
    } catch (error) {
        logger.warn(SOURCE_RECONCILE, 'Listing failed', { connectionId: row.id, error: error instanceof Error ? error.name : 'unknown' });
        await recordReconcileRun(admin, row, tenantKey, 'scheduled', 'failed', { error_code: 'listing_failed' });
        result.failed += 1;
        return;
    }
    if (listing.complete !== true) {
        await recordReconcileRun(admin, row, tenantKey, 'scheduled', 'incomplete', { listed: listing.fileIds.length });
        result.incomplete += 1;
        return;
    }
    const outcome = { paused: false };
    try {
        result.removed += await removeOrphans(row, listing.fileIds, 'scheduled', { complete: true, admin, outcome });
    } catch (error) {
        logger.warn(SOURCE_RECONCILE, 'Removal failed', { connectionId: row.id, code: errorCode(error) });
        await recordReconcileRun(admin, row, tenantKey, 'scheduled', 'failed', { error_code: 'removal_failed' });
        result.failed += 1;
        return;
    }
    if (outcome.paused) result.paused += 1;
}

/**
 * The scheduled full-listing reconcile (D-06, D-31). Connected connections that are due are listed oldest first within
 * the deadline. Only a complete listing removes, through removeOrphans with the D-09 guard; an incomplete or failed
 * listing records its run and removes nothing. The CLI and the internal route both call this function.
 */
export async function runSourceReconcile(options: SourceReconcileOptions): Promise<SourceReconcileResult> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const deadlineAt = startedAt + Math.max(0, options.deadlineMs);
    const admin = options.deps?.admin ?? getSupabaseAdmin();
    if (!admin) {
        throw new SourceReconcileDatabaseError('admin_unavailable');
    }
    const listFiles = options.deps?.listFiles ?? listConnectionFiles;
    const result: SourceReconcileResult = { processed: 0, removed: 0, paused: 0, incomplete: 0, failed: 0, skipped: 0, overdue: 0 };

    const rows = await loadConnections(admin, options.connectionId);
    const due = dueConnections(rows, startedAt, configuredDays('RAG_SOURCE_RECONCILE_INTERVAL_DAYS'));

    for (let index = 0; index < due.length; index += 1) {
        if (options.signal?.aborted || now() >= deadlineAt) {
            result.skipped = due.length - index;
            break;
        }
        result.processed += 1;
        await reconcileOne(admin, due[index] as ReconcileConnectionRow, listFiles, result);
    }

    logger.info(SOURCE_RECONCILE, 'Run finished', { ...result });
    return result;
}
