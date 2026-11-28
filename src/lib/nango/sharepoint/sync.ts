import type { getSupabaseAdmin } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { nangoPipeline, type ProcessDocumentOptions } from '../document-adapter';
import { nangoOwnerScope } from '@/lib/rag';
import {
    DELETION_BATCH_SIZE,
    applySourceDeletions,
    guardListingRemoval,
    type SourceConnectionRow,
    type SyncRecordRow,
} from '../source-deletions';
import type { NangoFileRecord, SyncStats } from '../types';
import { isSharePointProvider, sharePointIntegrationKey, type SharePointProvider } from './config';
import {
    GraphDeltaFeed,
    clearDeltaCursor,
    commitDeltaCursor,
    readDeltaCursor,
    type GraphChangePage,
    type GraphSourceChange,
} from './delta';
import { graphGet, nangoGraphTransport, pathAndQueryOf, type GraphTransport } from './graph';
import { parentMapOf, scopeOf, type DriveSelection, type ParentMap, type ScopeVerdict } from './scope';

/**
 * SharePoint Online / OneDrive for Business sync over the Graph drive delta (Phase 6.3, D-21, D-22, D-40, DATA-25).
 *
 * Per selected drive: read from the stored link, remove deleted items through the one deletion entry point (origin
 * change_feed), ingest added and changed in-scope files through the existing ingest path, and commit the link only
 * after the page set applied without a failure. A token-less enumeration that completes (first sync, after a 410, or
 * resumed across reads) is a full listing: synced files absent from it, or no longer in the selection, go through the
 * D-09 guarded removal, and a paused removal leaves the link uncommitted. State kept on the connection row
 * (`nango_connections.metadata`): `source_parents` (folder parent map per drive, D-22 scope walks) and
 * `source_enumeration` (file ids seen by a token-less enumeration that a deadline cut, so a resumed full listing is the
 * union of all its reads).
 */

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

const LOG = 'SharePoint';
const DEFAULT_DEADLINE_MS = 50_000;
const SYNCED_STATUSES = ['completed', 'processing'];
/** Most folder parent entries kept per drive on the connection row; beyond it scope walks fall back to unknown. */
export const MAX_STORED_PARENTS = 50_000;
/** Most file ids an interrupted enumeration keeps; beyond it the enumeration is not used as a full listing. */
export const MAX_ENUMERATION_IDS = 100_000;

export interface SharePointConnectionRow extends SourceConnectionRow {
    metadata?: unknown;
}

/** Helpers that live in sync-manager.ts and are shared with the other providers. */
export interface SharePointSyncHooks {
    markSourceSeen: (
        admin: SupabaseAdmin,
        input: { userId: string; connectionId: string; fileId: string; documentId: string | null | undefined; modifiedAt?: string | null; etag?: string | null },
    ) => Promise<void>;
    isSupportedFile: (name: string) => boolean;
    ownerOnlyLabel: (userId: string) => string[];
    processDocument: (name: string, content: Buffer, options: ProcessDocumentOptions) => Promise<string>;
    fetchContent: (provider: SharePointProvider, connectionId: string, file: NangoFileRecord) => Promise<Buffer>;
}

export interface SharePointSyncOptions {
    deadlineMs?: number;
    signal?: AbortSignal;
    /** Tests pass the fake Graph; production uses `nango.proxy`. */
    transport?: GraphTransport;
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SharePointSyncResult extends SyncStats {
    /** Drives whose link was committed in this run. */
    committedDrives: string[];
    /** True when a full-listing removal was paused for confirmation. */
    paused: boolean;
}

interface StoredSyncRecord extends SyncRecordRow {
    status?: string;
    metadata?: Record<string, unknown> | null;
}

interface DriveRun {
    driveId: string;
    page: GraphChangePage | null;
    failed: boolean;
    /** File ids an earlier, interrupted read of the same token-less enumeration saw. */
    priorIds: string[];
    /** True when this read finished a token-less enumeration (with its earlier reads). */
    fullListing: boolean;
    /** In-scope or unknown file ids of this read (present in the source). */
    presentIds: string[];
    parents: Map<string, string | null>;
    overflow: boolean;
    /** True when this read belongs to an enumeration that started without a delta link. */
    tokenlessStart: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const entryList = (value: unknown, needsDrive: boolean): Array<{ id: string; name: string; driveId: string }> => {
    if (!Array.isArray(value)) return [];
    const entries: Array<{ id: string; name: string; driveId: string }> = [];
    for (const raw of value) {
        const entry = asRecord(raw);
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        const driveId = typeof entry.driveId === 'string' ? entry.driveId.trim() : '';
        if (id === '' || id.length > 256 || (needsDrive && (driveId === '' || driveId.length > 256))) continue;
        entries.push({ id, name: typeof entry.name === 'string' ? entry.name : '', driveId });
    }
    return entries;
};

/** The selection stored by the connections route under `metadata.source_scope` (plan 06.3-13); null when absent. */
export function selectionOf(metadata: unknown): DriveSelection | null {
    const scope = asRecord(asRecord(metadata).source_scope);
    const sites = entryList(scope.sites, false).map(({ id, name }) => ({ id, name }));
    const drives = entryList(scope.drives, false).map(({ id, name }) => ({ id, name }));
    const folders = entryList(scope.folders, true);
    if (sites.length + drives.length + folders.length === 0) return null;
    return { sites, drives, folders };
}

function storedParents(metadata: unknown, driveId: string): Map<string, string | null> {
    const map = new Map<string, string | null>();
    const drive = asRecord(asRecord(asRecord(metadata).source_parents)[driveId]);
    for (const [id, parent] of Object.entries(drive)) {
        if (parent === null || typeof parent === 'string') map.set(id, parent);
    }
    return map;
}

function storedEnumeration(metadata: unknown, driveId: string): { ids: string[]; overflow: boolean } {
    const entry = asRecord(asRecord(asRecord(metadata).source_enumeration)[driveId]);
    const ids = Array.isArray(entry.present) ? entry.present.filter((id): id is string => typeof id === 'string') : [];
    return { ids, overflow: entry.overflow === true };
}

function abortError(): Error {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}

/** Drive ids the selection reads: selected drives, drives of selected folders and the drives of selected sites. */
async function selectedDrives(
    selection: DriveSelection,
    transport: GraphTransport,
    options: { deadline: number; signal: AbortSignal; now: () => number; sleep?: SharePointSyncOptions['sleep'] },
): Promise<{ drives: string[]; resolved: boolean; siteOfDrive: Map<string, string> }> {
    const drives = new Set<string>([...selection.drives.map((drive) => drive.id), ...selection.folders.map((folder) => folder.driveId)]);
    const siteOfDrive = new Map<string, string>();
    let resolved = true;
    for (const site of selection.sites) {
        try {
            let endpoint: string | null = `/v1.0/sites/${encodeURIComponent(site.id)}/drives?$select=id`;
            for (let page = 0; endpoint && page < 50; page++) {
                const response = await graphGet(transport, endpoint, { signal: options.signal, deadline: options.deadline, now: options.now, sleep: options.sleep });
                const body = asRecord(response.data);
                for (const raw of Array.isArray(body.value) ? body.value : []) {
                    const id = asRecord(raw).id;
                    if (typeof id === 'string' && id !== '') {
                        drives.add(id);
                        siteOfDrive.set(id, site.id);
                    }
                }
                const next = body['@odata.nextLink'];
                endpoint = null;
                if (typeof next === 'string' && next !== '') endpoint = pathAndQueryOf(next);
            }
            if (endpoint) resolved = false;
        } catch (error) {
            if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
            logger.warn(LOG, 'Site drives could not be listed', { error: error instanceof Error ? error.message.slice(0, 64) : 'unknown' });
            resolved = false;
        }
    }
    return { drives: [...drives], resolved, siteOfDrive };
}

async function loadSyncRecords(admin: SupabaseAdmin, connection: SourceConnectionRow): Promise<StoredSyncRecord[] | null> {
    const { data, error } = await admin
        .from('nango_sync_records')
        .select('id, file_id, file_name, document_id, status, metadata')
        .eq('connection_id', connection.connection_id)
        .eq('user_id', connection.user_id);
    if (error) {
        logger.error(LOG, 'Sync records could not be read', { code: (error as { code?: string }).code ?? null });
        return null;
    }
    return (data ?? []) as StoredSyncRecord[];
}

const recordDrive = (record: StoredSyncRecord): string | null => {
    const drive = asRecord(record.metadata).drive_id;
    return typeof drive === 'string' && drive !== '' ? drive : null;
};

/** Files whose stored parent chain reaches a deleted folder (Graph may report only the folder). */
function filesUnderDeletedFolders(records: StoredSyncRecord[], deletedFolders: Set<string>, parents: ParentMap, driveId: string): string[] {
    if (deletedFolders.size === 0) return [];
    const found: string[] = [];
    for (const record of records) {
        if (recordDrive(record) !== driveId) continue;
        const parent = asRecord(record.metadata).parent_id;
        let current: string | null | undefined = typeof parent === 'string' ? parent : undefined;
        const visited = new Set<string>();
        for (let depth = 0; depth < 256 && typeof current === 'string' && !visited.has(current); depth++) {
            if (deletedFolders.has(current)) {
                found.push(record.file_id);
                break;
            }
            visited.add(current);
            current = parents.get(current);
        }
    }
    return found;
}

async function removeChangeFeedDeletions(admin: SupabaseAdmin, connection: SourceConnectionRow, fileIds: string[]): Promise<{ removed: number; failed: boolean }> {
    let removed = 0;
    let failed = false;
    const unique = Array.from(new Set(fileIds));
    for (let start = 0; start < unique.length; start += DELETION_BATCH_SIZE) {
        const batch = unique.slice(start, start + DELETION_BATCH_SIZE);
        const result = await applySourceDeletions(connection, batch, 'change_feed', { admin });
        removed += result.removed;
        if (result.failed > 0 || result.deferred > 0) failed = true;
    }
    return { removed, failed };
}

async function writeConnectionState(
    admin: SupabaseAdmin,
    connection: SourceConnectionRow,
    update: (metadata: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
    const { data, error } = await admin.from('nango_connections').select('metadata').eq('id', connection.id).single();
    if (error) {
        logger.warn(LOG, 'Connection state not read', { code: (error as { code?: string }).code ?? null });
        return false;
    }
    const next = update({ ...asRecord((data as { metadata?: unknown } | null)?.metadata) });
    const { error: writeError } = await admin
        .from('nango_connections')
        .update({ metadata: next, updated_at: new Date().toISOString() })
        .eq('id', connection.id)
        .eq('user_id', connection.user_id);
    if (writeError) {
        logger.warn(LOG, 'Connection state not stored', { code: (writeError as { code?: string }).code ?? null });
        return false;
    }
    return true;
}

function folderParentsOnly(parents: Map<string, string | null>, page: GraphChangePage, previous: Map<string, string | null>): Record<string, string | null> {
    const folders = new Set<string>(page.rootIds ?? []);
    for (const id of previous.keys()) folders.add(id);
    for (const change of page.changes) if (change.kind === 'folder' && !change.deleted) folders.add(change.fileId);
    const out: Record<string, string | null> = {};
    for (const id of folders) {
        if (parents.has(id)) out[id] = parents.get(id) ?? null;
    }
    return out;
}

async function ingestFile(
    admin: SupabaseAdmin,
    connection: SourceConnectionRow,
    provider: SharePointProvider,
    change: GraphSourceChange,
    records: Map<string, StoredSyncRecord>,
    hooks: SharePointSyncHooks,
    stats: SyncStats,
): Promise<boolean> {
    const name = change.name ?? change.fileId;
    const existing = records.get(change.fileId);
    const existingMetadata = asRecord(existing?.metadata);
    const userId = connection.user_id;
    const connectionId = connection.connection_id;
    if (existing && existing.status === 'completed' && change.etag && existingMetadata.etag === change.etag) {
        await hooks.markSourceSeen(admin, { userId, connectionId, fileId: change.fileId, documentId: existing.document_id, modifiedAt: change.modifiedAt, etag: change.etag });
        stats.skipped++;
        return true;
    }
    const metadata: Record<string, unknown> = {
        drive_id: change.driveId,
        ...(change.siteId ? { site_id: change.siteId } : {}),
        ...(change.parentId ? { parent_id: change.parentId } : {}),
        ...(change.modifiedAt ? { modified_at: change.modifiedAt } : {}),
    };
    try {
        await admin.from('nango_sync_records').upsert({
            user_id: userId,
            connection_id: connectionId,
            provider,
            file_id: change.fileId,
            file_name: name,
            status: 'processing',
            metadata,
            updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,file_id' });

        const file: NangoFileRecord = { id: change.fileId, name, drive_id: change.driveId, modified_at: change.modifiedAt, etag: change.etag } as NangoFileRecord;
        const content = await hooks.fetchContent(provider, connectionId, file);
        const documentId = await hooks.processDocument(name, content, {
            userId,
            source: 'nango',
            sourceProvider: provider,
            sourceFileId: change.fileId,
            sourceConnectionId: connectionId,
            nangoConnectionId: connectionId,
            nangoFolderId: change.parentId,
            accessKeys: hooks.ownerOnlyLabel(userId),
        });
        await hooks.markSourceSeen(admin, { userId, connectionId, fileId: change.fileId, documentId, modifiedAt: change.modifiedAt, etag: change.etag });
        await admin.from('nango_sync_records').update({
            document_id: documentId,
            status: 'completed',
            metadata: { ...metadata, ...(change.etag ? { etag: change.etag } : {}) },
            last_synced_at: new Date().toISOString(),
            error_message: null,
            updated_at: new Date().toISOString(),
        }).eq('user_id', userId).eq('file_id', change.fileId);
        stats.processed++;
        return true;
    } catch (error) {
        logger.error(LOG, 'File not synced', { error: error instanceof Error ? error.name : 'unknown' });
        await admin.from('nango_sync_records').update({
            status: 'failed',
            error_message: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error',
            updated_at: new Date().toISOString(),
        }).eq('user_id', userId).eq('file_id', change.fileId);
        stats.failed++;
        return false;
    }
}

/** Reads the connection a SharePoint sync runs for; the owner comes from this row only. */
async function loadConnection(admin: SupabaseAdmin, connectionId: string): Promise<SharePointConnectionRow | null> {
    const { data, error } = await admin
        .from('nango_connections')
        .select('id, connection_id, user_id, provider, deletion_mode, metadata')
        .eq('connection_id', connectionId)
        .single();
    const row = data as SharePointConnectionRow | null;
    if (error || !row || typeof row.user_id !== 'string' || row.user_id === '' || typeof row.id !== 'string') return null;
    return { ...row, connection_id: connectionId };
}

/**
 * One sync of a SharePoint or OneDrive connection. The caller checks the switch (isSharePointEnabled) first.
 */
export async function syncSharePointConnection(
    connectionId: string,
    admin: SupabaseAdmin,
    hooks: SharePointSyncHooks,
    options: SharePointSyncOptions = {},
): Promise<SharePointSyncResult> {
    const result: SharePointSyncResult = { processed: 0, failed: 0, skipped: 0, deleted: 0, failClosed: 0, committedDrives: [], paused: false };
    const connection = await loadConnection(admin, connectionId);
    if (!connection) throw new Error(`Connection not found: ${connectionId}`);
    if (!isSharePointProvider(connection.provider)) throw new Error('Connection provider is not SharePoint or OneDrive');
    const provider = connection.provider;
    if (nangoPipeline() === 'unified') {
        const owner = nangoOwnerScope({ ownerUserId: connection.user_id });
        if (!owner.ok) throw new Error(`Connection owner cannot be a tenant (${owner.reason}): ${connectionId}`);
    }
    const selection = selectionOf(connection.metadata);
    if (!selection) {
        logger.debug(LOG, 'No selection stored for this connection; nothing to sync');
        return result;
    }

    const now = options.now ?? Date.now;
    const deadline = now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const signal = options.signal ?? new AbortController().signal;
    const transport = options.transport ?? nangoGraphTransport(sharePointIntegrationKey(provider), connectionId);

    const { drives, resolved, siteOfDrive } = await selectedDrives(selection, transport, { deadline, signal, now, sleep: options.sleep });
    const loadedRecords = await loadSyncRecords(admin, connection);
    if (loadedRecords === null) throw new Error('Sync records could not be read');
    const recordsById = new Map(loadedRecords.map((record) => [record.file_id, record]));

    const runs: DriveRun[] = [];
    for (const driveId of drives) {
        if (signal.aborted) throw abortError();
        const run: DriveRun = { driveId, page: null, failed: false, priorIds: [], fullListing: false, presentIds: [], parents: new Map(), overflow: false, tokenlessStart: false };
        runs.push(run);
        const key = { connectionRowId: connection.id, driveId };
        let feedFailed = false;
        try {
            const cursor = await readDeltaCursor(admin, key);
            const stored = storedParents(connection.metadata, driveId);
            const tokenless = cursor.deltaLink === null;
            if (tokenless && cursor.nextLink !== null) {
                const prior = storedEnumeration(connection.metadata, driveId);
                run.priorIds = prior.ids;
                run.overflow = prior.overflow;
            }
            let resynced = false;
            const feed = new GraphDeltaFeed({
                provider,
                driveId,
                transport,
                now,
                sleep: options.sleep,
                onResync: async () => {
                    resynced = true;
                    await clearDeltaCursor(admin, key);
                },
            });
            const page = await feed.read({ connectionId, cursor: cursor.deltaLink, nextLink: cursor.nextLink, deadline, signal });
            run.tokenlessStart = tokenless || resynced || page.resynced;
            if (resynced || page.resynced) {
                run.priorIds = [];
                run.overflow = false;
            }
            run.page = page;
            const parents = parentMapOf(page.changes as GraphSourceChange[], resynced ? new Map() : stored, page.rootIds);
            run.parents = parents;

            const deletedFiles: string[] = [];
            const deletedFolders = new Set<string>();
            const files: GraphSourceChange[] = [];
            for (const change of page.changes as GraphSourceChange[]) {
                if (change.deleted) {
                    if (change.kind === 'folder') deletedFolders.add(change.fileId);
                    else deletedFiles.push(change.fileId);
                } else if (change.kind === 'file') {
                    files.push(change);
                }
            }
            deletedFiles.push(...filesUnderDeletedFolders(loadedRecords, deletedFolders, stored, driveId));

            // Only ids this connection synced: a deleted item that was never synced changes nothing.
            const syncedDeletions = deletedFiles.filter((fileId) => recordsById.has(fileId));
            if (syncedDeletions.length > 0) {
                const removal = await removeChangeFeedDeletions(admin, connection, syncedDeletions);
                result.deleted += removal.removed;
                if (removal.failed) run.failed = true;
            }

            for (const change of files) {
                if (signal.aborted) throw abortError();
                const verdict: ScopeVerdict = scopeOf(
                    { fileId: change.fileId, parentId: change.parentId, driveId: change.driveId, siteId: change.siteId ?? siteOfDrive.get(change.driveId) },
                    selection,
                    parents,
                );
                if (verdict === 'out') continue;
                run.presentIds.push(change.fileId);
                if (verdict === 'unknown') {
                    logger.debug(LOG, 'Item scope unknown; not synced until a full enumeration places it');
                    continue;
                }
                if (!hooks.isSupportedFile(change.name ?? '')) {
                    result.skipped++;
                    continue;
                }
                const ok = await ingestFile(admin, connection, provider, change, recordsById, hooks, result);
                if (!ok) run.failed = true;
            }
            run.fullListing = page.fullListing && !run.overflow;
        } catch (error) {
            if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
            logger.error(LOG, 'Drive delta not applied', { error: error instanceof Error ? error.message.slice(0, 64) : 'unknown' });
            feedFailed = true;
            run.failed = true;
        }
        if (feedFailed) result.failed++;
    }

    // Full-listing reconciliation (D-09, D-21, D-22): the diff covers the drives whose token-less enumeration finished in
    // this run, and, once every selected drive was listed in full, the synced files of drives no longer selected.
    const fullRuns = runs.filter((run) => run.page && run.fullListing && !run.failed);
    const allFull = resolved && runs.length > 0 && fullRuns.length === runs.length;
    let fullRemovalPaused = false;
    let fullRemovalFailed = false;
    if (fullRuns.length > 0) {
        const fullDrives = new Set(fullRuns.map((run) => run.driveId));
        const readDrives = new Set(runs.map((run) => run.driveId));
        const present = new Set<string>();
        for (const run of fullRuns) {
            for (const id of run.priorIds) present.add(id);
            for (const id of run.presentIds) present.add(id);
        }
        const synced = loadedRecords.filter((record) => SYNCED_STATUSES.includes(record.status ?? 'completed'));
        const considered = synced.filter((record) => {
            const drive = recordDrive(record);
            if (drive === null) return false;
            return fullDrives.has(drive) || (allFull && !readDrives.has(drive));
        });
        const candidates = considered.filter((record) => !present.has(record.file_id));
        const guard = await guardListingRemoval({
            connection,
            orphanFileIds: candidates.map((record) => record.file_id),
            totalRecords: considered.length,
            listedCount: present.size,
            origin: 'sync',
            complete: allFull,
            admin,
        });
        if (guard.paused) {
            fullRemovalPaused = true;
            result.paused = true;
        } else if (candidates.length > 0) {
            const removal = await applySourceDeletions(connection, candidates.map((record) => record.file_id), 'reconcile', { admin, records: candidates });
            result.deleted += removal.removed;
            if (removal.failed > 0) fullRemovalFailed = true;
        }
    }

    // Commit (D-21): a drive's link is stored only after its page set applied without a failure; a full listing also
    // needs its guarded removal to have gone through.
    const parentsUpdate: Record<string, Record<string, string | null> | null> = {};
    const enumerationUpdate: Record<string, { present: string[]; overflow: boolean } | null> = {};
    for (const run of runs) {
        const page = run.page;
        if (!page || run.failed) continue;
        if (run.fullListing && (fullRemovalPaused || fullRemovalFailed)) continue;
        try {
            await commitDeltaCursor(admin, { connectionRowId: connection.id, driveId: run.driveId, page });
            result.committedDrives.push(run.driveId);
        } catch (error) {
            logger.warn(LOG, 'Delta link not stored', { error: error instanceof Error ? error.message : 'unknown' });
            continue;
        }
        const stored = storedParents(connection.metadata, run.driveId);
        const folders = folderParentsOnly(run.parents, page, stored);
        parentsUpdate[run.driveId] = Object.keys(folders).length <= MAX_STORED_PARENTS ? folders : null;
        const tokenlessCut = !page.complete && run.tokenlessStart;
        if (tokenlessCut) {
            const ids = Array.from(new Set([...run.priorIds, ...run.presentIds]));
            enumerationUpdate[run.driveId] = { present: ids.length <= MAX_ENUMERATION_IDS ? ids : [], overflow: run.overflow || ids.length > MAX_ENUMERATION_IDS };
        } else {
            enumerationUpdate[run.driveId] = null;
        }
    }
    if (result.committedDrives.length > 0) {
        await writeConnectionState(admin, connection, (metadata) => {
            const parents = { ...asRecord(metadata.source_parents) };
            for (const [drive, value] of Object.entries(parentsUpdate)) {
                if (value === null) delete parents[drive];
                else parents[drive] = value;
            }
            const enumeration = { ...asRecord(metadata.source_enumeration) };
            for (const [drive, value] of Object.entries(enumerationUpdate)) {
                if (value === null) delete enumeration[drive];
                else enumeration[drive] = value;
            }
            return { ...metadata, source_parents: parents, source_enumeration: enumeration };
        });
    }
    return result;
}

/**
 * The full listing of what a SharePoint or OneDrive connection selects, for the scheduled reconcile (D-31): a
 * token-less enumeration of every selected drive with a throwaway cursor. It never reads or writes the stored links and
 * ingests nothing. Items whose scope cannot be proven out stay in the listing, so they are never removal candidates.
 */
export async function listSharePointFiles(
    connection: SharePointConnectionRow,
    admin: SupabaseAdmin | null,
    options: SharePointSyncOptions = {},
): Promise<{ fileIds: string[]; complete: boolean }> {
    if (!isSharePointProvider(connection.provider)) return { fileIds: [], complete: false };
    const provider = connection.provider;
    let metadata = connection.metadata;
    if (metadata === undefined && admin) {
        const { data, error } = await admin.from('nango_connections').select('metadata').eq('id', connection.id).single();
        if (error) return { fileIds: [], complete: false };
        metadata = (data as { metadata?: unknown } | null)?.metadata;
    }
    const selection = selectionOf(metadata);
    if (!selection) return { fileIds: [], complete: false };

    const now = options.now ?? Date.now;
    const deadline = now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const signal = options.signal ?? new AbortController().signal;
    const transport = options.transport ?? nangoGraphTransport(sharePointIntegrationKey(provider), connection.connection_id);
    const fileIds = new Set<string>();
    let complete = true;
    try {
        const { drives, resolved, siteOfDrive } = await selectedDrives(selection, transport, { deadline, signal, now, sleep: options.sleep });
        if (!resolved) complete = false;
        for (const driveId of drives) {
            const feed = new GraphDeltaFeed({ provider, driveId, transport, now, sleep: options.sleep });
            const page = await feed.read({ connectionId: connection.connection_id, cursor: null, deadline, signal });
            if (!page.complete) complete = false;
            const parents = parentMapOf(page.changes as GraphSourceChange[], undefined, page.rootIds);
            for (const change of page.changes as GraphSourceChange[]) {
                if (change.deleted || change.kind !== 'file') continue;
                const verdict = scopeOf(
                    { fileId: change.fileId, parentId: change.parentId, driveId: change.driveId, siteId: change.siteId ?? siteOfDrive.get(change.driveId) },
                    selection,
                    parents,
                );
                if (verdict !== 'out') fileIds.add(change.fileId);
            }
            if (!complete) break;
        }
    } catch (error) {
        logger.error(LOG, 'Connection listing failed', { error: error instanceof Error ? error.message.slice(0, 64) : 'unknown' });
        complete = false;
    }
    return { fileIds: [...fileIds], complete };
}
