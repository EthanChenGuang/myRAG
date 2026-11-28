import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

/**
 * D-35: an admin-purged connector file that still exists at the source is not brought back by the next sync, in every
 * sync path (Drive folder, Drive by id, Notion by id, the Dropbox folder and multi-folder loops, the records fallback).
 * The SharePoint and OneDrive path is covered in sharepoint-sync.test.ts.
 */

const OWNER = TWO_TENANT_IDS.userA;
const CONNECTION = 'conn-tombstone';
const MODIFIED = '2026-01-01T00:00:00.000Z';

type Row = Record<string, unknown>;

interface ProxyRequest {
    connectionId: string;
    endpoint: string;
    data?: Record<string, unknown>;
}

const remote = {
    files: [] as Row[],
    driveMeta: {} as Record<string, Row>,
    notionPages: {} as Record<string, Row>,
    dropboxEntries: [] as Row[],
    records: [] as Row[],
};

const tombstones = {
    files: new Set<string>(),
    failing: false,
    calls: [] as Array<{ tenantKey: string; connectionId: string; fileId: string }>,
};

const proxy = vi.fn(async (request: ProxyRequest) => {
    const endpoint = request.endpoint;
    if (endpoint === '/drive/v3/files') return { data: { files: remote.files } };
    const meta = /^\/drive\/v3\/files\/([^/]+)$/.exec(endpoint);
    if (meta) return { data: remote.driveMeta[meta[1]] };
    const page = /^\/v1\/pages\/([^/]+)$/.exec(endpoint);
    if (page) return { data: remote.notionPages[page[1]] };
    if (/^\/v1\/blocks\/([^/]+)\/children$/.test(endpoint)) return { data: { results: [] } };
    if (endpoint === '/2/files/list_folder') return { data: { entries: remote.dropboxEntries } };
    throw new Error(`unexpected endpoint ${endpoint}`);
});

function createMemoryDb(seed: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = { nango_connections: [], nango_sync_records: [], documents: [], ...seed };
    function from(table: string) {
        let op = 'select' as 'select' | 'update' | 'upsert' | 'delete';
        let payload: Row = {};
        const filters: Array<{ column: string; value: unknown }> = [];
        const match = (row: Row) => filters.every((entry) => row[entry.column] === entry.value);
        const run = () => {
            const rows = tables[table] ?? (tables[table] = []);
            if (op === 'upsert') {
                const found = rows.find((row) => row.user_id === payload.user_id && row.file_id === payload.file_id);
                if (found) Object.assign(found, payload);
                else rows.push({ id: `rec-${rows.length + 1}`, ...payload });
                return [];
            }
            const matched = rows.filter(match);
            if (op === 'update') for (const row of matched) Object.assign(row, payload);
            if (op === 'delete') tables[table] = rows.filter((row) => !matched.includes(row));
            return matched;
        };
        const builder = {
            select: () => builder,
            update(value: Row) {
                op = 'update';
                payload = value;
                return builder;
            },
            upsert(value: Row) {
                op = 'upsert';
                payload = value;
                return builder;
            },
            delete() {
                op = 'delete';
                return builder;
            },
            eq(column: string, value: unknown) {
                filters.push({ column, value });
                return builder;
            },
            in: () => builder,
            limit: () => builder,
            single() {
                const found = run()[0];
                return Promise.resolve({ data: found ?? null, error: found ? null : { message: 'not found' } });
            },
            then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
                Promise.resolve({ data: run(), error: null }).then(onFulfilled, onRejected),
        };
        return builder;
    }
    return { tables, admin: { from, rpc: vi.fn(async () => ({ data: null, error: null })) } };
}

async function loadSyncManager(seed: Record<string, Row[]>) {
    vi.resetModules();
    const memory = createMemoryDb(seed);
    const ingests: string[] = [];
    const downloads: string[] = [];
    const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
    const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');

    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memory.admin }));
    vi.doMock('@/lib/nango/client', () => ({
        getNango: () => ({
            proxy,
            getConnection: vi.fn(async () => ({ credentials: { raw: {} } })),
            listRecords: vi.fn(async () => ({ records: remote.records, next_cursor: null })),
        }),
    }));
    vi.doMock('@/lib/nango/file-fetcher', () => ({
        fetchFileContent: vi.fn(async (_provider: string, _connection: string, file: { id: string }) => {
            downloads.push(file.id);
            return Buffer.from('synthetic content');
        }),
    }));
    vi.doMock('@/lib/nango/permission-sync', () => ({
        notionWorkspaceId: vi.fn(async () => null),
        syncSourcePermissions: vi.fn(async () => ({ outcome: 'skipped' })),
    }));
    vi.doMock('@/lib/document-processor', () => ({ processDocument: vi.fn() }));
    vi.doMock('@/lib/nango/document-adapter', () => ({
        nangoPipeline: () => 'unified',
        processDocumentWithMetadata: vi.fn(async (_name: string, _buffer: Buffer, options: Row) => {
            ingests.push(String(options.sourceFileId));
            return `doc-${String(options.sourceFileId)}`;
        }),
    }));
    vi.doMock('@/lib/rag/ingest/queue-config', () => ({ queueConfigFromProcessEnv: () => ({ ingestAsync: false }), resetQueueConfigForTests: () => {} }));
    vi.doMock('@/lib/rag', () => ({
        nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
            ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
        scopeKey: scopeModule.scopeKey,
        softDeleteLineage: vi.fn(async () => ({ ok: true })),
        removeDocumentObjects: vi.fn(async () => undefined),
        recomputeDirtyDupClusters: vi.fn(async () => ({ ok: true })),
        queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
        isPurgeTombstoned: vi.fn(async (scope: Parameters<typeof scopeModule.scopeKey>[0], connectionId: string, fileId: string) => {
            tombstones.calls.push({ tenantKey: scopeModule.scopeKey(scope), connectionId, fileId });
            if (tombstones.failing) return { ok: false, reason: 'unavailable' };
            return { ok: true, tombstoned: tombstones.files.has(fileId) };
        }),
    }));
    const module = await import('@/lib/nango/sync-manager');
    return { ...module, memory, ingests, downloads };
}

function connection(provider: string, syncFolder: string | null, syncFileIds: string[] | null = null): Row {
    return { id: `row-${CONNECTION}`, connection_id: CONNECTION, user_id: OWNER, provider, sync_folder_id: syncFolder, sync_file_ids: syncFileIds };
}

const driveFile = (id: string): Row => ({ id, name: `${id}.txt`, mimeType: 'text/plain', modifiedTime: MODIFIED });
const dropboxFile = (id: string, folder = ''): Row => ({ '.tag': 'file', id, name: `${id.replace(':', '-')}.txt`, path_display: `${folder}/${id}.txt`, client_modified: MODIFIED });
const syncRecordFor = (memory: { tables: Record<string, Row[]> }, fileId: string) => (memory.tables.nango_sync_records ?? []).find((row) => row.file_id === fileId);

describe('admin-purge tombstones stop re-ingestion (D-35)', () => {
    beforeEach(() => {
        remote.files = [];
        remote.driveMeta = {};
        remote.notionPages = {};
        remote.dropboxEntries = [];
        remote.records = [];
        tombstones.files = new Set();
        tombstones.failing = false;
        tombstones.calls = [];
        proxy.mockClear();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        for (const name of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher', '@/lib/nango/permission-sync', '@/lib/document-processor', '@/lib/nango/document-adapter', '@/lib/rag', '@/lib/rag/ingest/queue-config']) {
            vi.doUnmock(name);
        }
    });

    it('Drive folder: a tombstoned file is listed but gets no sync record, no download and no ingest; the other file is ingested', async () => {
        remote.files = [driveFile('f-gone'), driveFile('f-kept')];
        tombstones.files.add('f-gone');
        const { syncDocumentsForConnection, memory, ingests, downloads } = await loadSyncManager({ nango_connections: [connection('google-drive', 'folder-a')] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(stats).toMatchObject({ processed: 1, withdrawn: 1 });
        expect(ingests).toEqual(['f-kept']);
        expect(downloads).toEqual(['f-kept']);
        expect(syncRecordFor(memory, 'f-gone')).toBeUndefined();
        expect(tombstones.calls).toContainEqual({ tenantKey: `u:${OWNER}`, connectionId: CONNECTION, fileId: 'f-gone' });
    });

    it('Drive files picked by id: a tombstoned file is skipped and counted as withdrawn', async () => {
        remote.driveMeta = { f1: driveFile('f1'), f2: driveFile('f2') };
        tombstones.files.add('f1');
        const { syncDocumentsForConnection, memory, ingests } = await loadSyncManager({ nango_connections: [connection('google-drive', null, ['f1', 'f2'])] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(stats).toMatchObject({ processed: 1, withdrawn: 1 });
        expect(ingests).toEqual(['f2']);
        expect(syncRecordFor(memory, 'f1')).toBeUndefined();
    });

    it('Notion pages by id: a tombstoned page is skipped and counted as withdrawn', async () => {
        remote.notionPages = {
            p1: { object: 'page', id: 'p1', last_edited_time: MODIFIED, public_url: null, properties: {} },
            p2: { object: 'page', id: 'p2', last_edited_time: MODIFIED, public_url: null, properties: {} },
        };
        tombstones.files.add('p1');
        const { syncDocumentsForConnection, memory, ingests } = await loadSyncManager({ nango_connections: [connection('notion', null, ['p1', 'p2'])] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'notion');

        expect(stats).toMatchObject({ processed: 1, withdrawn: 1 });
        expect(ingests).toEqual(['p2']);
        expect(syncRecordFor(memory, 'p1')).toBeUndefined();
    });

    it('Dropbox folder (generic loop): a tombstoned file is skipped and counted as withdrawn', async () => {
        remote.dropboxEntries = [dropboxFile('id:d1'), dropboxFile('id:d2')];
        tombstones.files.add('id:d1');
        const { syncDocumentsForConnection, memory, ingests, downloads } = await loadSyncManager({ nango_connections: [connection('dropbox', '/folder')] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'dropbox');

        expect(stats).toMatchObject({ processed: 1, withdrawn: 1 });
        expect(ingests).toEqual(['id:d2']);
        expect(downloads).toEqual(['id:d2']);
        expect(syncRecordFor(memory, 'id:d1')).toBeUndefined();
    });

    it('Dropbox multi-folder loop: a tombstoned file is skipped and counted as withdrawn', async () => {
        remote.dropboxEntries = [dropboxFile('id:m1', '/a'), dropboxFile('id:m2', '/a')];
        tombstones.files.add('id:m1');
        const { syncDocumentsForConnection, memory, ingests } = await loadSyncManager({ nango_connections: [connection('dropbox', 'multi-folder-mode', ['/a'])] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'dropbox');

        expect(stats).toMatchObject({ processed: 1, withdrawn: 1 });
        expect(ingests).toEqual(['id:m2']);
        expect(syncRecordFor(memory, 'id:m1')).toBeUndefined();
    });

    it('records fallback (listRecords provider): a tombstoned file is skipped and counted as withdrawn', async () => {
        remote.records = [
            { id: 'b1', name: 'b1.txt', modified_at: MODIFIED },
            { id: 'b2', name: 'b2.txt', modified_at: MODIFIED },
        ];
        tombstones.files.add('b1');
        const { syncDocumentsForConnection, memory, ingests } = await loadSyncManager({ nango_connections: [connection('box', 'root')] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'box');

        expect(stats).toMatchObject({ processed: 1, withdrawn: 1 });
        expect(ingests).toEqual(['b2']);
        expect(syncRecordFor(memory, 'b1')).toBeUndefined();
    });

    it('after a source-sync purge (no tombstone) a restored file is ingested again', async () => {
        remote.files = [driveFile('f-restored')];
        const { syncDocumentsForConnection, ingests } = await loadSyncManager({ nango_connections: [connection('google-drive', 'folder-a')] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(stats.processed).toBe(1);
        expect(stats.withdrawn ?? 0).toBe(0);
        expect(ingests).toEqual(['f-restored']);
    });

    it('a failed tombstone lookup skips the file for this sync (fail closed) and logs the connection id only', async () => {
        remote.files = [driveFile('f-unknown')];
        tombstones.failing = true;
        const { syncDocumentsForConnection, memory, ingests } = await loadSyncManager({ nango_connections: [connection('google-drive', 'folder-a')] });

        const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(stats).toMatchObject({ processed: 0, skipped: 1 });
        expect(stats.withdrawn ?? 0).toBe(0);
        expect(ingests).toEqual([]);
        expect(syncRecordFor(memory, 'f-unknown')).toBeUndefined();
        const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
        expect(logged).toContain('Tombstone check failed');
        expect(logged).not.toContain('f-unknown');
    });
});
