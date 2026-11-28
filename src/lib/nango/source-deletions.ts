import { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { nangoPipeline } from './document-adapter';
import type { DeletionMode, DeletionOrigin } from './change-feed';
import {
    nangoOwnerScope,
    queueConfigFromProcessEnv,
    removeDocumentObjects,
    scopeKey,
    softDeleteLineage,
    type DocumentObjectRow,
} from '@/lib/rag';

/** Process deletions in batches to avoid timeouts; also the most file ids one change-feed call removes (D-33). */
export const DELETION_BATCH_SIZE = 50;

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

/** The connection a deletion runs for, as stored in nango_connections. Owner and mode are read from this row only. */
export interface SourceConnectionRow {
    /** nango_connections.id */
    id: string;
    /** nango_connections.connection_id (the Nango connection id, documents.source_connection_id) */
    connection_id: string;
    user_id: string;
    provider: string;
    deletion_mode?: string | null;
}

export interface SourceDeletionResult {
    /** Sync records removed after their lineage removal succeeded. */
    removed: number;
    /** Sync records kept because the removal failed; the next run retries them. */
    failed: number;
    /** File ids beyond the batch size that this call did not look at (change-feed and admin calls only). */
    deferred: number;
}

export interface SyncRecordRow {
    id: string;
    file_id: string;
    file_name: string;
    document_id: string | null;
}

export interface SourceDeletionOptions {
    /** Tests and the canary pass a PGlite admin; production callers never pass it. */
    admin?: SupabaseAdmin;
    /** Sync records the caller already loaded with the same filter (the listing diff of a sync). */
    records?: readonly SyncRecordRow[];
}

const SYNC_RECORD_COLUMNS = 'id, file_id, file_name, document_id';
const SYNCED_STATUSES = ['completed', 'processing'];
const SOURCE_RECONCILE = 'Source Reconcile';

export function deletionModeOf(connection: Pick<SourceConnectionRow, 'deletion_mode'>): DeletionMode {
    const mode = connection.deletion_mode;
    return mode === 'soft' || mode === 'purge' ? mode : null;
}

/** The tenant key of the connection owner, or null when the owner cannot be a tenant. */
export function connectionTenantKey(connection: Pick<SourceConnectionRow, 'user_id'>): string | null {
    const owner = nangoOwnerScope({ ownerUserId: connection.user_id });
    return owner.ok ? scopeKey(owner.scope) : null;
}

function resolveAdmin(admin: SupabaseAdmin | undefined): SupabaseAdmin {
    const resolved = admin ?? getSupabaseAdmin();
    if (!resolved) {
        throw new Error('Supabase admin client not available');
    }
    return resolved;
}

/**
 * Read the connection a deletion runs for. The owner and the deletion mode come from this row, never from a request.
 * Returns null when the row does not exist for this owner or the read failed.
 */
export async function loadSourceConnection(
    admin: SupabaseAdmin | null | undefined,
    connectionId: string,
    userId: string,
    options: { admin?: SupabaseAdmin } = {}
): Promise<SourceConnectionRow | null> {
    const client = resolveAdmin(options.admin ?? admin ?? undefined);
    const { data, error } = await client
        .from('nango_connections')
        .select('id, connection_id, user_id, provider, deletion_mode')
        .eq('connection_id', connectionId)
        .eq('user_id', userId)
        .limit(1);
    if (error) {
        logger.error('Nango', `Failed to read connection ${connectionId}`, { code: (error as { code?: string }).code ?? null });
        return null;
    }
    const row = ((data ?? []) as SourceConnectionRow[])[0];
    return row && typeof row.user_id === 'string' && row.user_id !== '' ? row : null;
}

export interface ReconcileRunCounts {
    listed?: number;
    total?: number;
    candidates?: number;
    error_code?: string;
}

/**
 * Bookkeeping through rag_source_reconcile_run_record (0721). A failure is logged with its code and never blocks a
 * removal that was allowed. Candidate ids are capped at the column limit; the count keeps the full number.
 */
export async function recordReconcileRun(
    admin: SupabaseAdmin,
    connection: SourceConnectionRow,
    tenantKey: string | null,
    origin: 'sync' | 'scheduled' | 'change_feed' | 'admin',
    status: 'completed' | 'incomplete' | 'failed' | 'awaiting_confirmation',
    counts: ReconcileRunCounts,
    candidateFileIds: readonly string[] = []
): Promise<{ runId: string | null }> {
    if (tenantKey === null) {
        logger.warn(SOURCE_RECONCILE, 'Run not recorded: the connection owner cannot be a tenant', { connectionId: connection.id });
        return { runId: null };
    }
    try {
        const { data, error } = await admin.rpc('rag_source_reconcile_run_record', {
            p_tenant_key: tenantKey,
            p_connection_id: connection.id,
            p_origin: origin,
            p_status: status,
            p_counts: counts,
            p_candidate_file_ids: candidateFileIds.slice(0, 2000),
        });
        if (error) {
            logger.warn(SOURCE_RECONCILE, 'Run not recorded', { connectionId: connection.id, origin, status, code: (error as { code?: string }).code ?? null });
            return { runId: null };
        }
        const row = (Array.isArray(data) ? data[0] : data) as { run_id?: unknown } | null | undefined;
        return { runId: typeof row?.run_id === 'string' ? row.run_id : null };
    } catch (error) {
        logger.warn(SOURCE_RECONCILE, 'Run not recorded', { connectionId: connection.id, origin, status, code: (error as { code?: string } | null)?.code ?? null });
        return { runId: null };
    }
}

async function loadSyncRecords(admin: SupabaseAdmin, connection: SourceConnectionRow, fileIds: readonly string[]): Promise<SyncRecordRow[] | null> {
    const { data, error } = await admin
        .from('nango_sync_records')
        .select(SYNC_RECORD_COLUMNS)
        .eq('connection_id', connection.connection_id)
        .eq('user_id', connection.user_id)
        .in('status', SYNCED_STATUSES)
        .in('file_id', [...fileIds]);
    if (error) {
        logger.error('Nango', 'Failed to fetch sync records for deletion', { code: (error as { code?: string }).code ?? null });
        return null;
    }
    return (data ?? []) as SyncRecordRow[];
}

async function deleteSyncRecord(admin: SupabaseAdmin, record: SyncRecordRow, userId: string): Promise<boolean> {
    const { error } = await admin.from('nango_sync_records').delete().eq('id', record.id).eq('user_id', userId);
    if (error) {
        logger.error('Nango', `Failed to delete sync record ${record.id}`, error);
        return false;
    }
    return true;
}

/**
 * The one deletion entry point (D-03). The owner and the mode come from the connection row; the tenant is the owner's
 * (nangoOwnerScope); lineages are found by identity within this connection (collectNangoLineageIds); a sync record is
 * deleted only after its lineage removal succeeded, so a failure is retried by the next run. Idempotent: file ids
 * without a sync record change nothing.
 */
export async function applySourceDeletions(
    connection: SourceConnectionRow,
    fileIds: readonly string[],
    origin: DeletionOrigin,
    options: SourceDeletionOptions = {}
): Promise<SourceDeletionResult> {
    const admin = resolveAdmin(options.admin);
    const unique = Array.from(new Set(fileIds.filter((fileId) => typeof fileId === 'string' && fileId !== '')));
    const limit = origin === 'reconcile' ? unique.length : DELETION_BATCH_SIZE;
    const selected = unique.slice(0, limit);
    const result: SourceDeletionResult = { removed: 0, failed: 0, deferred: unique.length - selected.length };
    if (selected.length === 0) return result;

    const wanted = new Set(selected);
    const loaded = options.records ? [...options.records] : await loadSyncRecords(admin, connection, selected);
    if (loaded === null) {
        result.failed = selected.length;
        return result;
    }
    const records = loaded.filter((record) => wanted.has(record.file_id));
    const mode = deletionModeOf(connection);

    if (mode === 'soft') {
        const tenantKey = connectionTenantKey(connection);
        for (const record of records) {
            const removed =
                tenantKey !== null &&
                (await softDeleteNangoLineages(admin, tenantKey, connection.connection_id, record.file_id, connection.user_id)) &&
                (await deleteSyncRecord(admin, record, connection.user_id));
            if (removed) result.removed++;
            else result.failed++;
        }
    } else if (mode === 'purge') {
        // The purge arm lands with plan 06.3-21; until then the batch fails whole and every sync record is kept.
        logger.warn(SOURCE_RECONCILE, 'Purge mode is not available yet; the batch is kept for retry', {
            connectionId: connection.id,
            count: records.length,
        });
        result.failed = records.length;
    } else {
        // The unset mode joins this entry point with applyDefaultDeletion (Task 2); until then nothing is removed here.
        result.failed = records.length;
    }

    if (origin === 'change_feed') {
        await recordReconcileRun(admin, connection, connectionTenantKey(connection), 'change_feed', result.failed > 0 ? 'failed' : 'completed', {
            listed: selected.length,
            candidates: records.length,
            ...(result.failed > 0 ? { error_code: 'removal_failed' } : {}),
        }, records.map((record) => record.file_id));
    }
    return result;
}

export function orphanUsesSoftDelete(): boolean {
    if (nangoPipeline() !== 'unified') return false;
    try {
        return queueConfigFromProcessEnv().ingestAsync;
    } catch {
        return false;
    }
}

export async function collectNangoLineageIds(
    supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    tenantKey: string,
    connectionId: string,
    fileId: string
): Promise<string[]> {
    const lineageIds = new Set<string>();
    for (const column of ['source_key', 'source_file_id'] as const) {
        const { data, error } = await supabaseAdmin
            .from('documents')
            .select('id, lineage_id')
            .eq('tenant_key', tenantKey)
            .eq('source', 'nango')
            .eq('source_connection_id', connectionId)
            .eq(column, fileId);
        if (error) throw error;
        for (const row of (data ?? []) as Array<{ id: string; lineage_id: string | null }>) {
            lineageIds.add(row.lineage_id ?? row.id);
        }
    }
    return Array.from(lineageIds);
}

export async function softDeleteNangoLineages(
    supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    tenantKey: string,
    connectionId: string,
    fileId: string,
    userId: string
): Promise<boolean> {
    try {
        const lineages = await collectNangoLineageIds(supabaseAdmin, tenantKey, connectionId, fileId);
        if (lineages.length === 0) return true;
        const owner = nangoOwnerScope({ ownerUserId: userId });
        if (!owner.ok) return false;
        const signal = AbortSignal.timeout(120_000);
        for (const lineageId of lineages) {
            const result = await softDeleteLineage(owner.scope, lineageId, 'nango', { signal });
            if (!result.ok) return false;
        }
        return true;
    } catch (error) {
        logger.error('Nango', `Failed to soft-delete the lineage of ${fileId}`, error);
        return false;
    }
}

/**
 * Delete every version of the files a source no longer has, inside one tenant. A file is found by its identity
 * (the provider file id of this connection), never by the document id a sync record holds: that id can name another
 * lineage when ingest reported a duplicate of an older, unrelated document. Returns false when a delete failed, so
 * the caller keeps the sync record and the next sync retries.
 */
export async function deleteNangoLineages(
    supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
    tenantKey: string,
    connectionId: string,
    fileId: string
): Promise<boolean> {
    try {
        const lineages = await collectNangoLineageIds(supabaseAdmin, tenantKey, connectionId, fileId);
        if (lineages.length === 0) return true;
        const { data: versions, error: versionsError } = await supabaseAdmin
            .from('documents')
            .select('id, version, lineage_id, original_path, processing_state')
            .in('lineage_id', lineages)
            .eq('tenant_key', tenantKey)
            .eq('source', 'nango');
        if (versionsError) throw versionsError;
        const versionRows = (versions ?? []) as DocumentObjectRow[];
        const versionIds = versionRows.map((version) => version.id);

        if (versionIds.length > 0) {
            const { error: chunksError } = await supabaseAdmin.from('document_chunks').delete().in('document_id', versionIds);
            if (chunksError) throw chunksError;
        }
        const { error: documentsError } = await supabaseAdmin
            .from('documents')
            .delete()
            .in('lineage_id', lineages)
            .eq('tenant_key', tenantKey)
            .eq('source', 'nango');
        if (documentsError) throw documentsError;
        // Best effort and after the rows: the originals and parse files of the removed versions leave the private bucket.
        await removeDocumentObjects({ tenantKey, rows: versionRows });
        return true;
    } catch (error) {
        logger.error('Nango', `Failed to delete the lineage of ${fileId}`, error);
        return false;
    }
}

export function parseMaxDeleteShare(_raw: string | undefined): number {
    return Number.NaN;
}

export function shouldPauseListingRemoval(_orphans: number, _total: number, _share: number): boolean {
    return false;
}

export async function guardListingRemoval(_input: Record<string, unknown>): Promise<{ paused: boolean }> {
    return { paused: false };
}
