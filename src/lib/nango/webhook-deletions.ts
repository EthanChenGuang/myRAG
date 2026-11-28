import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { NangoRecordsFeed, type SourceChangeFeed } from './change-feed';
import {
    DELETION_BATCH_SIZE,
    applySourceDeletions,
    guardListingRemoval,
    loadSourceConnection,
    type SourceConnectionRow,
} from './source-deletions';
import { PROVIDER_CONFIG, type NangoWebhookPayload, type SupportedProvider } from './types';

/**
 * Deletions reported by a Nango sync webhook (Phase 6.3, DATA-23, D-04, D-05, D-32, D-33).
 *
 * The body only names the connection and the model. The owner and the deletion mode come from the nango_connections
 * row; the deleted file ids are read again from the Nango records API, from the cursor stored in
 * rag_source_delta_tokens (feed 'nango_records', feed_key the model). Deletions go through applySourceDeletions in
 * batches of DELETION_BATCH_SIZE; the cursor is stored only after a batch was applied without a failure, so a cut or
 * failed batch is read again by the next webhook. A page set from a full sync is a listing diff and goes through the
 * mass-delete guard first. Unknown connections and every refusal return without effect; the route answers the same.
 */

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export const NANGO_RECORDS_FEED = 'nango_records';
const DELTA_TOKENS_TABLE = 'rag_source_delta_tokens';
const MAX_CURSOR_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;
const SYNCED_STATUSES = ['completed', 'processing'];
const TAG = 'Nango Webhook';

export type SyncWebhookStatus =
    | 'ignored'
    | 'unknown_connection'
    | 'nothing_deleted'
    | 'applied'
    | 'paused'
    | 'incomplete_listing'
    | 'failed';

export interface SyncWebhookOutcome {
    status: SyncWebhookStatus;
    removed: number;
    failed: number;
    batches: number;
    cursorStored: boolean;
}

export interface SyncWebhookOptions {
    /** Time budget of the whole call in milliseconds (the route passes 15 s, under Nango's 20 s timeout). */
    deadlineMs: number;
    signal?: AbortSignal;
    /** Tests pass an in-memory admin; production callers never pass it. */
    admin?: SupabaseAdmin;
    /** Tests pass a fake feed; the default is NangoRecordsFeed. */
    feedFor?: (input: { providerConfigKey: string; model: string }) => SourceChangeFeed;
    now?: () => number;
}

interface DeletedEntry {
    fileId: string;
    cursor: string | null;
}

function outcome(status: SyncWebhookStatus, partial: Partial<SyncWebhookOutcome> = {}): SyncWebhookOutcome {
    return { status, removed: 0, failed: 0, batches: 0, cursorStored: false, ...partial };
}

function errorCode(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
}

/** The Nango integration key of a stored provider: the configured integration id, or the provider id itself. */
function integrationKeysOf(provider: string): Set<string> {
    const keys = new Set<string>([provider]);
    const config = PROVIDER_CONFIG[provider as SupportedProvider];
    if (config?.integrationId) keys.add(config.integrationId);
    return keys;
}

async function readOwner(admin: SupabaseAdmin, connectionId: string): Promise<string | null> {
    const { data, error } = await admin.from('nango_connections').select('user_id').eq('connection_id', connectionId).limit(1);
    if (error) {
        logger.warn(TAG, 'Connection read failed', { code: errorCode(error) });
        return null;
    }
    const row = ((data ?? []) as Array<{ user_id?: unknown }>)[0];
    return typeof row?.user_id === 'string' && row.user_id !== '' ? row.user_id : null;
}

async function readStoredCursor(admin: SupabaseAdmin, connection: SourceConnectionRow, model: string): Promise<{ ok: boolean; cursor: string | null }> {
    const { data, error } = await admin
        .from(DELTA_TOKENS_TABLE)
        .select('delta_link')
        .eq('connection_id', connection.id)
        .eq('feed', NANGO_RECORDS_FEED)
        .eq('feed_key', model)
        .limit(1);
    if (error) {
        logger.warn(TAG, 'Records cursor read failed', { connectionId: connection.id, code: errorCode(error) });
        return { ok: false, cursor: null };
    }
    const row = ((data ?? []) as Array<{ delta_link?: unknown }>)[0];
    return { ok: true, cursor: typeof row?.delta_link === 'string' && row.delta_link !== '' ? row.delta_link : null };
}

async function storeCursor(admin: SupabaseAdmin, connection: SourceConnectionRow, model: string, cursor: string): Promise<boolean> {
    if (cursor.length > MAX_CURSOR_LENGTH) {
        logger.warn(TAG, 'Records cursor not stored: too long', { connectionId: connection.id, length: cursor.length });
        return false;
    }
    const { error } = await admin.from(DELTA_TOKENS_TABLE).upsert(
        {
            connection_id: connection.id,
            feed: NANGO_RECORDS_FEED,
            feed_key: model,
            delta_link: cursor,
            next_link: null,
            updated_at: new Date().toISOString(),
        },
        { onConflict: 'connection_id,feed,feed_key' }
    );
    if (error) {
        logger.warn(TAG, 'Records cursor not stored', { connectionId: connection.id, code: errorCode(error) });
        return false;
    }
    return true;
}

async function countSyncRecords(admin: SupabaseAdmin, connection: SourceConnectionRow): Promise<number | null> {
    const { data, error, count } = (await admin
        .from('nango_sync_records')
        .select('id', { count: 'exact', head: true })
        .eq('connection_id', connection.connection_id)
        .eq('user_id', connection.user_id)
        .in('status', SYNCED_STATUSES)) as { data: unknown[] | null; error: unknown; count?: number | null };
    if (error) {
        logger.warn(TAG, 'Sync record count failed', { connectionId: connection.id, code: errorCode(error) });
        return null;
    }
    if (typeof count === 'number') return count;
    return Array.isArray(data) ? data.length : null;
}

/** Deleted file ids in feed order, each at its last occurrence, with the feed position just after it. */
function deletedEntries(changes: ReadonlyArray<{ fileId: string; deleted: boolean; cursor?: string }>): DeletedEntry[] {
    const lastIndex = new Map<string, number>();
    changes.forEach((change, index) => {
        if (change.deleted && change.fileId !== '') lastIndex.set(change.fileId, index);
    });
    return [...lastIndex.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([fileId, index]) => ({ fileId, cursor: changes[index].cursor ?? null }));
}

/**
 * Applies the deletions a signed Nango `type: 'sync'` webhook reports (D-05). Never throws for a refusal: every
 * outcome is returned so the route can answer one body for all of them.
 */
export async function handleSyncWebhook(payload: NangoWebhookPayload, options: SyncWebhookOptions): Promise<SyncWebhookOutcome> {
    const now = options.now ?? Date.now;
    const deadline = now() + Math.max(0, options.deadlineMs);
    const signal = options.signal ?? new AbortController().signal;

    if (payload.type !== 'sync' || payload.success !== true) return outcome('ignored');
    const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId : '';
    const model = typeof payload.model === 'string' ? payload.model : '';
    const providerConfigKey = typeof payload.providerConfigKey === 'string' ? payload.providerConfigKey : '';
    if (connectionId === '' || providerConfigKey === '' || model === '' || model.length > MAX_MODEL_LENGTH) return outcome('ignored');

    const admin = options.admin ?? getSupabaseAdmin();
    if (!admin) {
        logger.error(TAG, 'Supabase admin not available');
        return outcome('failed');
    }

    const ownerId = await readOwner(admin, connectionId);
    const connection = ownerId === null ? null : await loadSourceConnection(admin, connectionId, ownerId, { admin });
    if (!connection) return outcome('unknown_connection');
    if (!integrationKeysOf(connection.provider).has(providerConfigKey)) {
        logger.warn(TAG, 'Integration key does not match the connection', { connectionId: connection.id });
        return outcome('ignored');
    }

    const stored = await readStoredCursor(admin, connection, model);
    if (!stored.ok) return outcome('failed');

    const feed = options.feedFor
        ? options.feedFor({ providerConfigKey, model })
        : new NangoRecordsFeed({ providerConfigKey, model });
    const readDeadline = now() + Math.floor((deadline - now()) / 2);
    let page;
    try {
        page = await feed.read({ connectionId: connection.connection_id, cursor: stored.cursor, deadline: readDeadline, signal });
    } catch (error) {
        logger.warn(TAG, 'Deleted records read failed', { connectionId: connection.id, code: errorCode(error) });
        return outcome('failed');
    }

    const entries = deletedEntries(page.changes);
    if (entries.length === 0) {
        const advance = page.complete && page.nextCursor !== null && page.nextCursor !== stored.cursor;
        const cursorStored = advance ? await storeCursor(admin, connection, model, page.nextCursor as string) : false;
        return outcome('nothing_deleted', { cursorStored });
    }

    const result = outcome('applied');
    for (let start = 0; start < entries.length; start += DELETION_BATCH_SIZE) {
        if (signal.aborted || now() >= deadline) break;
        const batch = entries.slice(start, start + DELETION_BATCH_SIZE);
        const applied = await applySourceDeletions(connection, batch.map((entry) => entry.fileId), 'change_feed', { admin });
        result.batches++;
        result.removed += applied.removed;
        result.failed += applied.failed;
        if (applied.failed > 0 || applied.deferred > 0) {
            result.status = 'failed';
            break;
        }
        const isLast = start + DELETION_BATCH_SIZE >= entries.length;
        const cursor = isLast && page.complete ? page.nextCursor ?? batch[batch.length - 1].cursor : batch[batch.length - 1].cursor;
        if (cursor !== null && cursor !== stored.cursor) {
            result.cursorStored = (await storeCursor(admin, connection, model, cursor)) || result.cursorStored;
        }
    }

    logger.info(TAG, 'Sync deletions handled', {
        connectionId: connection.id,
        status: result.status,
        candidates: entries.length,
        removed: result.removed,
        failed: result.failed,
        batches: result.batches,
    });
    return result;
}

/** The auth operation word, for the log only. */
export function authOperationOf(payload: NangoWebhookPayload): string {
    const operation = typeof payload.operation === 'string' ? payload.operation : '';
    return ['creation', 'override', 'refresh', 'deletion'].includes(operation) ? operation : 'other';
}
