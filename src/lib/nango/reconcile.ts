import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { listConnectionFiles, removeOrphans, type ListableConnectionRow } from './sync-manager';
import { connectionTenantKey, recordReconcileRun } from './source-deletions';
import { raiseSourceAlert } from './source-alerts';
import { rescrubRecentPurges, retryPendingPurgeObjects, type RescrubResult, type RetryPendingResult } from '@/lib/rag';

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
    /** The purge follow-ups (D-15, C-10); default to the purge library. */
    purge?: {
        retry: (input: { limit?: number; signal: AbortSignal }) => Promise<RetryPendingResult>;
        rescrub: (input: { signal: AbortSignal }) => Promise<RescrubResult>;
    };
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
    /** Pending purge objects (and cache invalidations) removed by this run's retry (D-15). */
    purgeRetried: number;
    /** Pending purge objects still waiting after the retry. */
    purgeStillPending: number;
    /** Chat messages scrubbed again for purges of the last 7 days (C-10). */
    purgeRescrubbed: number;
    /** Purge follow-up steps (retry, re-scrub) not run because the deadline passed or the run was aborted. */
    purgeSkipped: number;
    /** Purge follow-up steps that failed; the connection reconciliation still ran. */
    purgeFailed: number;
}

/** Pending purge records retried per run (D-15). */
const PURGE_RETRY_LIMIT = 50;

function isAbortError(error: unknown): boolean {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * The purge follow-ups at the start of a run (D-15, C-10): re-scrub recent purges, then retry pending objects, so the
 * check the retry stores sees the scrubbed chats. Each step gets at most half the time left, so the connection loop
 * keeps its share; a step with no time left is skipped and counted.
 */
async function runPurgeFollowUps(
    purge: NonNullable<SourceReconcileDeps['purge']>,
    now: () => number,
    deadlineAt: number,
    outer: AbortSignal | undefined,
    result: SourceReconcileResult
): Promise<void> {
    const steps: Array<(signal: AbortSignal) => Promise<void>> = [
        async (signal) => {
            const rescrubbed = await purge.rescrub({ signal });
            if (!rescrubbed.ok) throw Object.assign(new Error('purge_rescrub_failed'), { code: rescrubbed.reason });
            result.purgeRescrubbed += rescrubbed.scrubbed;
        },
        async (signal) => {
            const retried = await purge.retry({ limit: PURGE_RETRY_LIMIT, signal });
            if (!retried.ok) throw Object.assign(new Error('purge_retry_failed'), { code: retried.reason });
            result.purgeRetried += retried.cleared;
            result.purgeStillPending += retried.stillPending;
        },
    ];
    for (const step of steps) {
        const left = deadlineAt - now();
        if (outer?.aborted || left <= 0) {
            result.purgeSkipped += 1;
            continue;
        }
        const timeout = AbortSignal.timeout(Math.max(1, Math.floor(left / 2)));
        const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
        try {
            await step(signal);
        } catch (error) {
            if (isAbortError(error) || signal.aborted) {
                result.purgeSkipped += 1;
            } else {
                result.purgeFailed += 1;
                logger.warn(SOURCE_RECONCILE, 'Purge follow-up failed', { code: errorCode(error), error: error instanceof Error ? error.name : 'unknown' });
            }
        }
    }
    if (result.purgeRetried + result.purgeStillPending + result.purgeRescrubbed + result.purgeSkipped + result.purgeFailed > 0) {
        logger.info(SOURCE_RECONCILE, 'Purge follow-ups', {
            retried: result.purgeRetried,
            stillPending: result.purgeStillPending,
            rescrubbed: result.purgeRescrubbed,
            skipped: result.purgeSkipped,
            failed: result.purgeFailed,
        });
    }
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
    const result: SourceReconcileResult = {
        processed: 0,
        removed: 0,
        paused: 0,
        incomplete: 0,
        failed: 0,
        skipped: 0,
        overdue: 0,
        purgeRetried: 0,
        purgeStillPending: 0,
        purgeRescrubbed: 0,
        purgeSkipped: 0,
        purgeFailed: 0,
    };

    await runPurgeFollowUps(
        options.deps?.purge ?? { retry: retryPendingPurgeObjects, rescrub: rescrubRecentPurges },
        now,
        deadlineAt,
        options.signal,
        result
    );

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

    await alertOverdue(admin, options.connectionId, now(), configuredDays('RAG_SOURCE_RECONCILE_MAX_AGE_DAYS'), result);

    logger.info(SOURCE_RECONCILE, 'Run finished', { ...result });
    return result;
}

/** Whole days since the last completed reconcile, or since connected_at when there is none. */
export function daysWithoutReconcile(row: Pick<ReconcileConnectionRow, 'last_full_reconcile_at' | 'connected_at'>, nowMs: number): number | null {
    const reference = timeOf(row.last_full_reconcile_at) ?? timeOf(row.connected_at);
    if (reference === null) return null;
    return Math.max(0, Math.floor((nowMs - reference) / DAY_MS));
}

function isOverdue(days: number | null, maxAgeDays: number): boolean {
    return days !== null && days > maxAgeDays;
}

async function scheduledAttempts(admin: SupabaseAdmin, connectionIds: readonly string[]): Promise<Set<string> | null> {
    if (connectionIds.length === 0) return new Set();
    const { data, error } = await admin
        .from('rag_source_reconcile_runs')
        .select('connection_id')
        .eq('origin', 'scheduled')
        .in('connection_id', [...connectionIds]);
    if (error) {
        logger.warn(SOURCE_RECONCILE, 'Scheduled runs not read; age not evaluated', { code: errorCode(error) });
        return null;
    }
    return new Set(((data ?? []) as Array<{ connection_id: unknown }>).map((entry) => String(entry.connection_id)));
}

/**
 * The age alert of D-10 with the first-run rule of D-39: evaluated after the reconcile loop, from a fresh read of the
 * connections, and only for a connection that a scheduled run has already attempted. One alert per connection per run.
 */
async function alertOverdue(
    admin: SupabaseAdmin,
    connectionId: string | undefined,
    nowMs: number,
    maxAgeDays: number,
    result: SourceReconcileResult
): Promise<void> {
    let rows: ReconcileConnectionRow[];
    try {
        rows = await loadConnections(admin, connectionId);
    } catch {
        return;
    }
    const aged = rows.filter((row) => isOverdue(daysWithoutReconcile(row, nowMs), maxAgeDays));
    if (aged.length === 0) return;
    const attempted = await scheduledAttempts(admin, aged.map((row) => row.id));
    if (attempted === null) return;
    for (const row of aged) {
        if (!attempted.has(row.id)) continue;
        await raiseSourceAlert(row, 'overdue', { days: daysWithoutReconcile(row, nowMs) ?? 0, limit: maxAgeDays }, { admin });
        result.overdue += 1;
    }
}

export type ReconcileState = 'in_step' | 'overdue' | 'paused' | 'failed' | 'incomplete' | 'not_run';

export interface ReconcileRunSummary {
    origin: string;
    status: string;
    error_code?: string | null;
    created_at?: string | null;
    expires_at?: string | null;
}

export interface ConnectionReconcileState {
    states: ReconcileState[];
    daysWithoutReconcile: number | null;
    reason: string | null;
}

/**
 * The reconcile state of one connection for the admin list and the app connector card (UI-SPEC 6.3, 8.1), from the
 * connection row, its newest run and the limits. Paused comes first and can stand with overdue; overdue needs a
 * scheduled attempt (D-39), before which the state is not_run unless a newer result says otherwise.
 */
export function connectionReconcileState(
    row: Pick<ReconcileConnectionRow, 'last_full_reconcile_at' | 'connected_at' | 'last_reconcile_status'>,
    newestRun: ReconcileRunSummary | null,
    hasScheduledAttempt: boolean,
    now: number,
    limits: { maxAgeDays: number }
): ConnectionReconcileState {
    const days = daysWithoutReconcile(row, now);
    const states: ReconcileState[] = [];
    let reason: string | null = null;

    const runStatus = newestRun?.status ?? null;
    const pausedRun = runStatus === 'awaiting_confirmation' && (timeOf(newestRun?.expires_at) ?? Number.POSITIVE_INFINITY) > now;
    const rowStatus = newestRun === null ? row.last_reconcile_status ?? null : null;
    if (pausedRun || rowStatus === 'paused') states.push('paused');
    if (hasScheduledAttempt && isOverdue(days, limits.maxAgeDays)) states.push('overdue');
    if (states.length > 0) return { states, daysWithoutReconcile: days, reason };

    const status = runStatus ?? rowStatus;
    if (status === 'failed') {
        reason = newestRun?.error_code ?? 'listing_failed';
        states.push('failed');
    } else if (status === 'incomplete') {
        reason = newestRun?.error_code ?? 'listing_incomplete';
        states.push('incomplete');
    } else if (!hasScheduledAttempt && (row.last_full_reconcile_at == null || isOverdue(days, limits.maxAgeDays))) {
        states.push('not_run');
    } else if (row.last_full_reconcile_at != null) {
        states.push('in_step');
    } else {
        states.push('not_run');
    }
    return { states, daysWithoutReconcile: days, reason };
}
