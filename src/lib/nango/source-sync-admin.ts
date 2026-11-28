import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { PROVIDER_CONFIG, type SupportedProvider } from './types';
import {
    DELETION_BATCH_SIZE,
    applySourceDeletions,
    connectionTenantKey,
    parseMaxDeleteShare,
    type SourceConnectionRow,
} from './source-deletions';
import { connectionReconcileState, parseReconcileDays, type ReconcileRunSummary, type ReconcileState } from './reconcile';

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;
type Row = Record<string, unknown>;

const SOURCE_SYNC = 'Source Sync';
/** The most file names a paused run sends to the browser (UI-SPEC 8.1). */
export const PAUSED_FILE_NAMES = 20;

export type SourceSyncFailure = 'not_found' | 'invalid_argument' | 'run_not_pending' | 'confirmation_expired' | 'unavailable';
export type SourceSyncResult<T> = ({ ok: true } & T) | { ok: false; reason: SourceSyncFailure };
export type DeletionModeValue = 'soft' | 'purge' | null;

const SQL_WORDS: readonly SourceSyncFailure[] = ['not_found', 'invalid_argument', 'run_not_pending', 'confirmation_expired'];

/** Only the fixed words the 0721 functions raise leave this module; anything else is unavailable. */
function failureOf(error: { message?: unknown; code?: unknown } | null | undefined): SourceSyncFailure {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    if ((SQL_WORDS as readonly string[]).includes(message)) return message as SourceSyncFailure;
    if (error?.code === '22023') return 'invalid_argument';
    return 'unavailable';
}

function codeOf(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
}

function adminClient(): SupabaseAdmin | null {
    try {
        return getSupabaseAdmin() ?? null;
    } catch {
        return null;
    }
}

function firstRow(data: unknown): Row | null {
    if (Array.isArray(data)) return (data[0] as Row | undefined) ?? null;
    return data && typeof data === 'object' ? (data as Row) : null;
}

async function callRpc(
    client: SupabaseAdmin,
    fn: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined
): Promise<{ ok: true; data: unknown } | { ok: false; reason: SourceSyncFailure }> {
    try {
        signal?.throwIfAborted();
        let request = client.rpc(fn as never, args as never) as unknown as {
            abortSignal?: (s: AbortSignal) => unknown;
        } & PromiseLike<{ data: unknown; error: { message?: unknown; code?: unknown } | null }>;
        if (signal && typeof request.abortSignal === 'function') request = request.abortSignal(signal) as typeof request;
        const { data, error } = await request;
        if (error) {
            const reason = failureOf(error);
            if (reason === 'unavailable') logger.error(SOURCE_SYNC, `${fn} failed`, { code: codeOf(error) });
            return { ok: false, reason };
        }
        return { ok: true, data };
    } catch (error) {
        logger.error(SOURCE_SYNC, `${fn} failed`, { code: codeOf(error) });
        return { ok: false, reason: 'unavailable' };
    }
}

async function decide(runId: string, actorUserId: string, decision: 'confirm' | 'dismiss', signal: AbortSignal | undefined) {
    const client = adminClient();
    if (!client) return { client: null, result: { ok: false as const, reason: 'unavailable' as const } };
    const result = await callRpc(client, 'rag_source_reconcile_run_decide', { p_actor: actorUserId, p_run_id: runId, p_decision: decision }, signal);
    return { client, result };
}

/** The connection row of a decided run, read by its id and the owner the SQL function returned. */
async function loadRunConnection(client: SupabaseAdmin, connectionId: string, ownerUserId: string): Promise<SourceConnectionRow | null> {
    try {
        const { data, error } = await client
            .from('nango_connections')
            .select('id, connection_id, user_id, provider, deletion_mode')
            .eq('id', connectionId)
            .eq('user_id', ownerUserId)
            .limit(1);
        if (error) {
            logger.error(SOURCE_SYNC, 'Connection of a confirmed run not read', { code: codeOf(error) });
            return null;
        }
        const row = ((data ?? []) as SourceConnectionRow[])[0];
        return row && typeof row.connection_id === 'string' && row.user_id === ownerUserId ? row : null;
    } catch (error) {
        logger.error(SOURCE_SYNC, 'Connection of a confirmed run not read', { code: codeOf(error) });
        return null;
    }
}

/**
 * D-09: an admin of the run's tenant confirms a paused run within 24 hours (enforced in SQL). The candidates are removed
 * through applySourceDeletions with origin admin, in the deletion mode of the connection row, batch by batch; the counts are
 * stored with rag_source_reconcile_run_finish. The actor is always the verified admin passed in by the route.
 */
export async function confirmReconcileRun(input: {
    runId: string;
    actorUserId: string;
    signal?: AbortSignal;
}): Promise<SourceSyncResult<{ runId: string; removed: number; failed: number }>> {
    const { client, result } = await decide(input.runId, input.actorUserId, 'confirm', input.signal);
    if (!result.ok || !client) return result.ok ? { ok: false, reason: 'unavailable' } : result;
    const row = firstRow(result.data);
    if (!row || row.status !== 'confirmed' || typeof row.connection_id !== 'string' || typeof row.owner_user_id !== 'string') {
        return { ok: false, reason: 'unavailable' };
    }
    const connection = await loadRunConnection(client, row.connection_id, row.owner_user_id);
    if (!connection || connectionTenantKey(connection) !== row.tenant_key) {
        logger.error(SOURCE_SYNC, 'Confirmed run left without removal: connection not usable', { runId: input.runId });
        return { ok: false, reason: 'unavailable' };
    }

    const candidates = Array.isArray(row.candidate_file_ids)
        ? (row.candidate_file_ids as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '')
        : [];
    let removed = 0;
    let failed = 0;
    for (let start = 0; start < candidates.length; start += DELETION_BATCH_SIZE) {
        const batch = candidates.slice(start, start + DELETION_BATCH_SIZE);
        try {
            const outcome = await applySourceDeletions(connection, batch, 'admin', { admin: client });
            removed += outcome.removed;
            failed += outcome.failed;
        } catch (error) {
            logger.error(SOURCE_SYNC, 'Removal batch of a confirmed run failed', { runId: input.runId, code: codeOf(error) });
            failed += batch.length;
        }
    }

    const finish = await callRpc(client, 'rag_source_reconcile_run_finish', { p_run_id: input.runId, p_removed: removed, p_failed: failed }, undefined);
    if (!finish.ok) logger.error(SOURCE_SYNC, 'Counts of a confirmed run not stored', { runId: input.runId, reason: finish.reason });
    return { ok: true, runId: input.runId, removed, failed };
}

/** D-09: dismisses a paused run; nothing is removed. An expired run is recorded as expired. */
export async function dismissReconcileRun(input: {
    runId: string;
    actorUserId: string;
    signal?: AbortSignal;
}): Promise<SourceSyncResult<{ runId: string; status: string }>> {
    const { result } = await decide(input.runId, input.actorUserId, 'dismiss', input.signal);
    if (!result.ok) return result;
    const row = firstRow(result.data);
    const status = row?.status === 'expired' ? 'expired' : row?.status === 'dismissed' ? 'dismissed' : null;
    if (status === null) return { ok: false, reason: 'unavailable' };
    return { ok: true, runId: input.runId, status };
}

/** D-08: sets the deletion mode of one connection of the admin's tenants; future deletions only, nothing is purged now. */
export async function setDeletionMode(input: {
    connectionId: string;
    mode: DeletionModeValue;
    actorUserId: string;
    signal?: AbortSignal;
}): Promise<SourceSyncResult<{ connectionId: string; mode: DeletionModeValue }>> {
    const client = adminClient();
    if (!client) return { ok: false, reason: 'unavailable' };
    const result = await callRpc(
        client,
        'rag_source_sync_set_deletion_mode',
        { p_actor: input.actorUserId, p_connection_id: input.connectionId, p_mode: input.mode },
        input.signal
    );
    if (!result.ok) return result;
    const row = firstRow(result.data);
    if (!row || row.connection_id !== input.connectionId) return { ok: false, reason: 'unavailable' };
    const mode = row.deletion_mode === 'soft' || row.deletion_mode === 'purge' ? row.deletion_mode : null;
    return { ok: true, connectionId: input.connectionId, mode };
}

// --- connections list (D-10, D-39, D-41) and the card state (D-26)

interface RunRow {
    connection_id: string;
    origin: string;
    status: string;
    error_code: string | null;
    created_at: string | null;
    expires_at: string | null;
}

interface RunFacts {
    newest: Map<string, ReconcileRunSummary>;
    scheduled: Set<string>;
}

function timeOf(value: unknown): number {
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Newest run and whether a scheduled run attempted each connection, read on the service-role client by connection id. */
async function readRunFacts(client: SupabaseAdmin, connectionIds: readonly string[]): Promise<RunFacts | null> {
    const facts: RunFacts = { newest: new Map(), scheduled: new Set() };
    if (connectionIds.length === 0) return facts;
    try {
        const { data, error } = await client
            .from('rag_source_reconcile_runs')
            .select('connection_id, origin, status, error_code, created_at, expires_at')
            .in('connection_id', [...connectionIds])
            .order('created_at', { ascending: false });
        if (error) {
            logger.warn(SOURCE_SYNC, 'Reconcile runs not read', { code: codeOf(error) });
            return null;
        }
        for (const run of (data ?? []) as RunRow[]) {
            const id = String(run.connection_id);
            if (run.origin === 'scheduled') facts.scheduled.add(id);
            const current = facts.newest.get(id);
            if (!current || timeOf(run.created_at) > timeOf(current.created_at)) {
                facts.newest.set(id, {
                    origin: run.origin,
                    status: run.status,
                    error_code: run.error_code,
                    created_at: run.created_at,
                    expires_at: run.expires_at,
                });
            }
        }
        return facts;
    } catch (error) {
        logger.warn(SOURCE_SYNC, 'Reconcile runs not read', { code: codeOf(error) });
        return null;
    }
}

function limits() {
    return {
        maxAgeDays: parseReconcileDays(env.RAG_SOURCE_RECONCILE_MAX_AGE_DAYS as string | undefined),
        maxDeleteShare: parseMaxDeleteShare(env.RAG_SOURCE_RECONCILE_MAX_DELETE_SHARE as string | undefined),
    };
}

export type CardReconcileState = 'ok' | 'overdue' | 'paused';

/** Paused wins over overdue; everything else is ok (D-26, UI-SPEC 6.8). */
export function cardStateOf(states: readonly ReconcileState[]): CardReconcileState {
    if (states.includes('paused')) return 'paused';
    if (states.includes('overdue')) return 'overdue';
    return 'ok';
}

/**
 * The read-only card state of the session user's own connections, keyed by nango_connections.id. Returns null when the runs
 * could not be read, so the caller leaves the field out and the card renders as before.
 */
export async function cardReconcileStates(
    rows: ReadonlyArray<{ id?: unknown; connected_at?: unknown; last_full_reconcile_at?: unknown; last_reconcile_status?: unknown }>,
    options: { admin?: SupabaseAdmin | null; now?: number } = {}
): Promise<Map<string, CardReconcileState> | null> {
    const client = options.admin ?? adminClient();
    if (!client) return null;
    const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === 'string' && id !== '');
    const facts = await readRunFacts(client, ids);
    if (facts === null) return null;
    const now = options.now ?? Date.now();
    const { maxAgeDays } = limits();
    const states = new Map<string, CardReconcileState>();
    for (const row of rows) {
        if (typeof row.id !== 'string') continue;
        const state = connectionReconcileState(
            {
                connected_at: typeof row.connected_at === 'string' ? row.connected_at : null,
                last_full_reconcile_at: typeof row.last_full_reconcile_at === 'string' ? row.last_full_reconcile_at : null,
                last_reconcile_status: typeof row.last_reconcile_status === 'string' ? row.last_reconcile_status : null,
            },
            facts.newest.get(row.id) ?? null,
            facts.scheduled.has(row.id),
            now,
            { maxAgeDays }
        );
        states.set(row.id, cardStateOf(state.states));
    }
    return states;
}

export interface SourceSyncPausedRun {
    id: string;
    found_at: string | null;
    expires_at: string | null;
    candidate_count: number;
    total_count: number | null;
    file_names: string[];
    names_not_sent: number;
}

export interface SourceSyncConnectionItem {
    id: string;
    provider: string;
    provider_name: string;
    owner: { id: string; label: string };
    workspace_key: string;
    status: string | null;
    document_count: number;
    connected_at: string | null;
    last_full_reconcile_at: string | null;
    states: ReconcileState[];
    reason: string | null;
    days_without_reconcile: number | null;
    deletion_mode: DeletionModeValue;
    paused_run: SourceSyncPausedRun | null;
}

export interface SourceSyncConnectionList {
    total: number;
    limit: number;
    offset: number;
    limits: { max_age_days: number; max_delete_share: number };
    items: SourceSyncConnectionItem[];
}

function providerName(provider: string): string {
    return PROVIDER_CONFIG[provider as SupportedProvider]?.displayName ?? provider;
}

async function ownerLabels(client: SupabaseAdmin, ids: readonly string[], signal: AbortSignal | undefined): Promise<Map<string, string>> {
    const labels = new Map<string, string>(ids.map((id) => [id, id]));
    await Promise.all(
        [...new Set(ids)].map(async (id) => {
            try {
                signal?.throwIfAborted();
                const { data } = await client.auth.admin.getUserById(id);
                const user = data?.user;
                const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
                const label = [user?.email, meta.full_name, meta.name].find((value): value is string => typeof value === 'string' && value.trim() !== '');
                if (label) labels.set(id, label.trim());
            } catch {
                // the id stays the label
            }
        })
    );
    return labels;
}

/** Up to 20 file names of the candidates that still have a sync record, from the run's candidate ids. */
async function pausedFileNames(client: SupabaseAdmin, runId: string, connectionRowId: string, ownerUserId: string): Promise<string[]> {
    try {
        const { data: runs, error: runError } = await client
            .from('rag_source_reconcile_runs')
            .select('candidate_file_ids')
            .eq('id', runId)
            .eq('connection_id', connectionRowId)
            .limit(1);
        if (runError) return [];
        const candidates = (((runs ?? []) as Row[])[0]?.candidate_file_ids ?? []) as unknown[];
        const ids = candidates.filter((id): id is string => typeof id === 'string' && id !== '');
        if (ids.length === 0) return [];
        const { data: connections, error: connectionError } = await client
            .from('nango_connections')
            .select('connection_id')
            .eq('id', connectionRowId)
            .eq('user_id', ownerUserId)
            .limit(1);
        const nangoId = (((connections ?? []) as Row[])[0]?.connection_id ?? null) as string | null;
        if (connectionError || typeof nangoId !== 'string') return [];
        const wanted = ids.slice(0, PAUSED_FILE_NAMES);
        const { data: records, error: recordError } = await client
            .from('nango_sync_records')
            .select('file_id, file_name')
            .eq('connection_id', nangoId)
            .eq('user_id', ownerUserId)
            .in('file_id', wanted);
        if (recordError) return [];
        const names = new Map(((records ?? []) as Row[]).map((record) => [String(record.file_id), record.file_name]));
        return wanted
            .map((id) => names.get(id))
            .filter((name): name is string => typeof name === 'string' && name !== '')
            .slice(0, PAUSED_FILE_NAMES);
    } catch (error) {
        logger.warn(SOURCE_SYNC, 'File names of a paused run not read', { runId, code: codeOf(error) });
        return [];
    }
}

function groupOf(states: readonly ReconcileState[]): number {
    if (states.includes('paused')) return 0;
    if (states.includes('overdue')) return 1;
    if (states.includes('failed') || states.includes('incomplete')) return 2;
    return 3;
}

function numberOf(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function textOf(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * D-10, D-39, D-41: the connections of the tenants the verified admin administers (resolved in SQL), with the reconcile state,
 * days without a completed reconcile, the deletion mode and the open paused run. Rows of the page are ordered paused, overdue,
 * failed or incomplete, then the rest, each group by provider name and owner label.
 */
export async function listSourceSyncConnections(input: {
    actorUserId: string;
    limit: number;
    offset: number;
    signal?: AbortSignal;
    now?: number;
}): Promise<SourceSyncResult<{ list: SourceSyncConnectionList }>> {
    const client = adminClient();
    if (!client) return { ok: false, reason: 'unavailable' };
    const result = await callRpc(
        client,
        'rag_source_sync_admin_connections',
        { p_actor: input.actorUserId, p_limit: input.limit, p_offset: input.offset },
        input.signal
    );
    if (!result.ok) return result;
    const rows = (Array.isArray(result.data) ? result.data : []) as Row[];
    const valid = rows.filter((row) => typeof row.connection_id === 'string' && typeof row.owner_user_id === 'string');
    const now = input.now ?? Date.now();
    const configured = limits();

    const facts = (await readRunFacts(client, valid.map((row) => row.connection_id as string))) ?? { newest: new Map(), scheduled: new Set<string>() };
    const labels = await ownerLabels(client, valid.map((row) => row.owner_user_id as string), input.signal);

    const items = await Promise.all(
        valid.map(async (row): Promise<SourceSyncConnectionItem> => {
            const id = row.connection_id as string;
            const owner = row.owner_user_id as string;
            const awaitingId = textOf(row.awaiting_run_id);
            const expiresAt = textOf(row.awaiting_expires_at);
            const openRun: ReconcileRunSummary | null =
                awaitingId !== null ? { origin: 'scheduled', status: 'awaiting_confirmation', created_at: textOf(row.awaiting_created_at), expires_at: expiresAt } : null;
            const newest = facts.newest.get(id) ?? null;
            const state = connectionReconcileState(
                {
                    connected_at: textOf(row.connected_at),
                    last_full_reconcile_at: textOf(row.last_full_reconcile_at),
                    last_reconcile_status: textOf(row.last_reconcile_status),
                },
                openRun ?? newest,
                facts.scheduled.has(id),
                now,
                { maxAgeDays: configured.maxAgeDays }
            );
            let pausedRun: SourceSyncPausedRun | null = null;
            if (awaitingId !== null) {
                const candidateCount = numberOf(row.awaiting_candidate_count) ?? 0;
                const names = await pausedFileNames(client, awaitingId, id, owner);
                pausedRun = {
                    id: awaitingId,
                    found_at: textOf(row.awaiting_created_at),
                    expires_at: expiresAt,
                    candidate_count: candidateCount,
                    total_count: numberOf(row.awaiting_total_count),
                    file_names: names,
                    names_not_sent: Math.max(0, candidateCount - names.length),
                };
            }
            const mode = row.deletion_mode === 'soft' || row.deletion_mode === 'purge' ? row.deletion_mode : null;
            const provider = String(row.provider ?? '');
            return {
                id,
                provider,
                provider_name: providerName(provider),
                owner: { id: owner, label: labels.get(owner) ?? owner },
                workspace_key: String(row.tenant_key ?? ''),
                status: textOf(row.status),
                document_count: numberOf(row.document_count) ?? 0,
                connected_at: textOf(row.connected_at),
                last_full_reconcile_at: textOf(row.last_full_reconcile_at),
                states: state.states,
                reason: state.reason,
                days_without_reconcile: state.daysWithoutReconcile,
                deletion_mode: mode,
                paused_run: pausedRun,
            };
        })
    );

    items.sort(
        (a, b) =>
            groupOf(a.states) - groupOf(b.states) ||
            a.provider_name.localeCompare(b.provider_name) ||
            a.owner.label.localeCompare(b.owner.label) ||
            a.id.localeCompare(b.id)
    );

    return {
        ok: true,
        list: {
            total: rows.length > 0 ? numberOf(rows[0]?.total_rows) ?? rows.length : 0,
            limit: input.limit,
            offset: input.offset,
            limits: { max_age_days: configured.maxAgeDays, max_delete_share: configured.maxDeleteShare },
            items,
        },
    };
}
