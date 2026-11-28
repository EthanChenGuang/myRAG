import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

const OWNER = TWO_TENANT_IDS.userA;
const MEMBER = TWO_TENANT_IDS.userB;
const CONNECTION = 'conn-loops';
const FOLDER = 'folder-loops';
const GROUP_A = '00000000-0000-4000-8000-00000000a001';
const OWNER_ONLY = [`u:${OWNER}`];

type Row = Record<string, unknown>;

interface ProxyRequest {
    providerConfigKey?: string;
    connectionId: string;
    method?: string;
    endpoint: string;
    retries?: number;
    params?: Record<string, string>;
    data?: Record<string, unknown>;
}

const remote = {
    files: [] as Row[],
    driveMeta: {} as Record<string, Row>,
    permissions: {} as Record<string, Row[] | 'rate_limited'>,
    notionPages: {} as Record<string, Row>,
    notionChildren: {} as Record<string, Row[]>,
    dropboxEntries: [] as Row[],
    dropboxMembers: {} as Record<string, Row>,
    notionRaw: { workspace_id: 'ws-loops' } as Row | null,
    calls: [] as ProxyRequest[],
};

function httpError(status: number, data: unknown = {}) {
    return Object.assign(new Error(`status ${status}`), { response: { status, data } });
}

const proxy = vi.fn(async (request: ProxyRequest) => {
    remote.calls.push(request);
    const endpoint = request.endpoint;
    if (endpoint === '/drive/v3/files') return { data: { files: remote.files } };
    const perms = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(endpoint);
    if (perms) {
        const entry = remote.permissions[decodeURIComponent(perms[1])];
        if (entry === undefined || entry === 'rate_limited') throw httpError(429, { error: { message: 'rate limit exceeded' } });
        return { data: { permissions: entry } };
    }
    const meta = /^\/drive\/v3\/files\/([^/]+)$/.exec(endpoint);
    if (meta) return { data: remote.driveMeta[meta[1]] };
    const page = /^\/v1\/pages\/([^/]+)$/.exec(endpoint);
    if (page) return { data: remote.notionPages[page[1]] };
    const children = /^\/v1\/blocks\/([^/]+)\/children$/.exec(endpoint);
    if (children) return { data: { results: remote.notionChildren[children[1]] ?? [] } };
    if (endpoint === '/v1/search') return { data: { results: Object.values(remote.notionPages) } };
    if (endpoint === '/2/files/list_folder') return { data: { entries: remote.dropboxEntries } };
    if (endpoint === '/2/sharing/list_folder_members') return { data: { users: [], groups: [], invitees: [] } };
    if (endpoint === '/2/sharing/list_file_members') {
        const members = remote.dropboxMembers[String(request.data?.file)];
        if (!members) throw httpError(409, { error_summary: 'access_error/' });
        return { data: members };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
});

const getConnection = vi.fn(async () => ({ credentials: { type: 'OAUTH2', access_token: 'placeholder', raw: remote.notionRaw ?? {} } }));

/** The tenant's admin-maintained mapping (provider, kind, external id) → group, and the enabled sharing rules. */
const mapping = {
    groups: new Map<string, string>(),
    rules: new Set<string>(),
    members: new Map<string, string>(),
};

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
            single() {
                const found = run()[0];
                return Promise.resolve({ data: found ?? null, error: found ? null : { message: 'not found' } });
            },
            then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) =>
                Promise.resolve({ data: run(), error: null }).then(onFulfilled, onRejected),
        };
        return builder;
    }
    return { tables, admin: { from } };
}

interface Harness {
    memory: ReturnType<typeof createMemoryDb>;
    ingests: Array<{ name: string; options: Row }>;
    applied: Array<{ documentId: string; status: string; principals: Row[] }>;
}

function labelOf(harness: Harness, documentId: string): string[] | undefined {
    return (harness.memory.tables.documents ?? []).find((row) => row.id === documentId)?.access_groups as string[] | undefined;
}

async function loadSyncManager(seed: Record<string, Row[]>, opts: { maxFiles?: string; deploymentMode?: 'single-tenant' | 'multi-tenant'; pipeline?: 'legacy' | 'unified' } = {}) {
    vi.resetModules();
    if (opts.maxFiles) process.env.NANGO_MAX_FILES_PER_SYNC = opts.maxFiles;
    else delete process.env.NANGO_MAX_FILES_PER_SYNC;
    const memory = createMemoryDb(seed);
    const harness: Harness = { memory, ingests: [], applied: [] };
    const mode = opts.deploymentMode ?? 'single-tenant';
    const pipeline = opts.pipeline ?? 'unified';
    const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
    const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
    const tenantKey = mode === 'multi-tenant' ? `u:${OWNER}` : 's:default';

    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memory.admin }));
    vi.doMock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, getConnection, listRecords: vi.fn() }) }));
    vi.doMock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('synthetic content')) }));
    vi.doMock('@/lib/document-processor', () => ({ processDocument: vi.fn() }));
    vi.doMock('@/lib/nango/document-adapter', () => ({
        nangoPipeline: () => pipeline,
        processDocumentWithMetadata: vi.fn(async (name: string, _buffer: Buffer, options: Row) => {
            harness.ingests.push({ name, options });
            const documents = memory.tables.documents ?? [];
            const existing = documents.find((row) => row.source_file_id === options.sourceFileId && row.source_connection_id === CONNECTION);
            const id = existing ? (existing.id as string) : `doc-${String(options.sourceFileId)}`;
            const label = (options.accessKeys as string[] | undefined) ?? ['all'];
            if (existing) existing.access_groups = label;
            else
                documents.push({
                    id,
                    tenant_key: tenantKey,
                    user_id: OWNER,
                    source: 'nango',
                    source_connection_id: CONNECTION,
                    source_file_id: options.sourceFileId,
                    source_key: options.sourceFileId,
                    access_groups: label,
                });
            return id;
        }),
    }));
    vi.doMock('@/lib/rag/ingest/queue-config', () => ({ queueConfigFromProcessEnv: () => ({ ingestAsync: false }), resetQueueConfigForTests: () => {} }));
    vi.doMock('@/lib/rag', () => ({
        CONNECTOR_MAX_PRINCIPALS: 5000,
        isPurgeTombstoned: async () => ({ ok: true, tombstoned: false }),
        recomputeDirtyDupClusters: async () => ({ ok: true }),
        nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
            ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: mode }),
        scopeKey: scopeModule.scopeKey,
        softDeleteLineage: vi.fn(async () => ({ ok: true })),
        removeDocumentObjects: vi.fn(async () => undefined),
        queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
        matchConnectorMembers: vi.fn(async (_scope: unknown, addresses: string[]) => addresses.map((address) => mapping.members.get(address) ?? null)),
        applyConnectorAccess: vi.fn(async (scope: unknown, input: { documentId: string; provider: string; principals: Row[]; ownerId: string; status: string }) => {
            expect(scopeModule.scopeKey(scope as Parameters<typeof scopeModule.scopeKey>[0])).toBe(tenantKey);
            harness.applied.push({ documentId: input.documentId, status: input.status, principals: [...input.principals] });
            const keys: string[] = [];
            let unmapped = input.status !== 'ok';
            for (const principal of input.principals) {
                if (principal.kind === 'user') {
                    if (principal.memberId) keys.push(`u:${String(principal.memberId)}`);
                    else unmapped = true;
                } else if (principal.kind === 'group' || principal.kind === 'workspace' || principal.kind === 'team') {
                    const group = mapping.groups.get(`${input.provider}:${String(principal.kind)}:${String(principal.id)}`);
                    if (group) keys.push(`g:${group}`);
                    else unmapped = true;
                } else {
                    const ruleKey = `${input.provider}:${String(principal.kind)}:${String(principal.id ?? '')}`;
                    if (mapping.rules.has(ruleKey)) keys.push('all');
                    else unmapped = true;
                }
            }
            const failClosed = unmapped;
            const label = failClosed || keys.length === 0 ? [`u:${input.ownerId}`] : keys.includes('all') ? ['all'] : [...new Set(keys)].sort();
            const document = (memory.tables.documents ?? []).find((row) => row.id === input.documentId);
            if (document) document.access_groups = label;
            const reason = input.status !== 'ok' ? 'source_error' : unmapped ? 'unmapped_source' : keys.length === 0 ? 'owner_only' : 'source_mapped';
            return { keys: label, failClosed, reason };
        }),
    }));
    const module = await import('@/lib/nango/sync-manager');
    return { ...module, harness };
}

function connection(provider: string, syncFolder: string | null, syncFileIds: string[] | null = null): Row {
    return { id: `row-${CONNECTION}`, connection_id: CONNECTION, user_id: OWNER, provider, sync_folder_id: syncFolder, sync_file_ids: syncFileIds };
}

const MODIFIED = '2026-01-01T00:00:00.000Z';

function driveFile(id: string): Row {
    return { id, name: `${id}.txt`, mimeType: 'text/plain', modifiedTime: MODIFIED };
}

const groupShare = (address: string): Row => ({ id: `p-${address}`, type: 'group', role: 'reader', emailAddress: address });
const ownerShare: Row = { id: 'p-owner', type: 'user', role: 'owner', emailAddress: 'owner@example.test' };
const domainShare: Row = { id: 'p-domain', type: 'domain', role: 'reader', domain: 'example.test' };

describe('connector sync loops run the permission step on every file', () => {
    beforeEach(() => {
        remote.files = [];
        remote.driveMeta = {};
        remote.permissions = {};
        remote.notionPages = {};
        remote.notionChildren = {};
        remote.dropboxEntries = [];
        remote.dropboxMembers = {};
        remote.notionRaw = { workspace_id: 'ws-loops' };
        remote.calls = [];
        proxy.mockClear();
        getConnection.mockClear();
        mapping.groups = new Map([['google-drive:group:team-a@example.test', GROUP_A]]);
        mapping.rules = new Set();
        mapping.members = new Map([['owner@example.test', OWNER]]);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
        delete process.env.NANGO_MAX_FILES_PER_SYNC;
        for (const name of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher', '@/lib/document-processor', '@/lib/nango/document-adapter', '@/lib/rag', '@/lib/rag/ingest/queue-config']) {
            vi.doUnmock(name);
        }
    });

    it('re-maps an unchanged Drive file after its sharing changed, falls back when unmapped, and maps again (D-20)', async () => {
        remote.files = [driveFile('f1')];
        remote.permissions.f1 = [ownerShare, groupShare('team-a@example.test')];
        const { syncDocumentsForConnection, harness } = await loadSyncManager({ nango_connections: [connection('google-drive', FOLDER)] });

        const first = await syncDocumentsForConnection(CONNECTION, 'google-drive');
        expect(first.processed).toBe(1);
        expect(labelOf(harness, 'doc-f1')).toEqual([`g:${GROUP_A}`, `u:${OWNER}`].sort());

        remote.permissions.f1 = [ownerShare, groupShare('team-b@example.test')];
        const second = await syncDocumentsForConnection(CONNECTION, 'google-drive');
        expect(second.skipped).toBe(1);
        expect(harness.ingests).toHaveLength(1);
        expect(labelOf(harness, 'doc-f1')).toEqual(OWNER_ONLY);
        expect(second.failClosed).toBe(1);

        mapping.groups.set('google-drive:group:team-b@example.test', GROUP_A);
        const third = await syncDocumentsForConnection(CONNECTION, 'google-drive');
        expect(third.skipped).toBe(1);
        expect(third.failClosed).toBe(0);
        expect(labelOf(harness, 'doc-f1')).toEqual([`g:${GROUP_A}`, `u:${OWNER}`].sort());

        const record = (harness.memory.tables.nango_sync_records ?? []).find((row) => row.file_id === 'f1');
        const summary = (record?.metadata as Row | undefined)?.access as Row | undefined;
        expect(summary).toMatchObject({ failClosed: false, reason: 'source_mapped', counts: { user: 1, group: 1, domain: 0, anyone: 0 } });
        expect(JSON.stringify(record?.metadata)).not.toContain('@');
    });

    it('calls the permission step for every file of the processing slice, with proxy retries', async () => {
        remote.files = ['a', 'b', 'c', 'd', 'e'].map(driveFile);
        for (const id of ['a', 'b', 'c', 'd', 'e']) remote.permissions[id] = [ownerShare];
        const { syncDocumentsForConnection, harness } = await loadSyncManager({ nango_connections: [connection('google-drive', FOLDER)] }, { maxFiles: '3' });

        await syncDocumentsForConnection(CONNECTION, 'google-drive');
        await syncDocumentsForConnection(CONNECTION, 'google-drive');

        const permissionCalls = remote.calls.filter((call) => call.endpoint.endsWith('/permissions'));
        expect(permissionCalls).toHaveLength(6);
        expect(permissionCalls.every((call) => call.retries !== undefined && call.retries > 0)).toBe(true);
        expect(new Set(harness.applied.map((entry) => entry.documentId))).toEqual(new Set(['doc-a', 'doc-b', 'doc-c']));
    });

    it('closes a group-labelled document whose permission call keeps failing, and counts it', async () => {
        remote.files = [driveFile('f1')];
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('google-drive', FOLDER)],
            nango_sync_records: [{ id: 'rec-f1', user_id: OWNER, connection_id: CONNECTION, file_id: 'f1', document_id: 'doc-f1', status: 'completed', last_synced_at: '2026-06-01T00:00:00.000Z', metadata: {} }],
            documents: [{ id: 'doc-f1', tenant_key: 's:default', user_id: OWNER, source: 'nango', source_connection_id: CONNECTION, source_file_id: 'f1', source_key: 'f1', access_groups: [`g:${GROUP_A}`] }],
        });
        remote.permissions.f1 = 'rate_limited';

        const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(stats.skipped).toBe(1);
        expect(stats.failClosed).toBe(1);
        expect(labelOf(harness, 'doc-f1')).toEqual(OWNER_ONLY);
        expect(harness.applied.at(-1)?.status).toBe('source_error');
    });

    const syncedRecord = (fileId: string, documentId: string): Row => ({
        id: `rec-${fileId}`,
        user_id: OWNER,
        connection_id: CONNECTION,
        file_id: fileId,
        document_id: documentId,
        status: 'completed',
        last_synced_at: '2026-06-01T00:00:00.000Z',
        metadata: {},
    });
    const syncedDocument = (id: string, fileId: string, label: string[], tenantKey = 's:default'): Row => ({
        id,
        tenant_key: tenantKey,
        user_id: OWNER,
        source: 'nango',
        source_connection_id: CONNECTION,
        source_file_id: fileId,
        source_key: fileId,
        access_groups: label,
    });

    it('Drive files picked by id: unchanged files get the step before the skip, new ones are ingested owner-only', async () => {
        remote.driveMeta = { f1: driveFile('f1'), f2: driveFile('f2') };
        remote.permissions = { f1: [groupShare('team-b@example.test')], f2: [groupShare('team-a@example.test')] };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('google-drive', null, ['f1', 'f2'])],
            nango_sync_records: [syncedRecord('f1', 'doc-f1')],
            documents: [syncedDocument('doc-f1', 'f1', [`g:${GROUP_A}`])],
        });

        const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(stats).toMatchObject({ skipped: 1, processed: 1, failClosed: 1 });
        expect(labelOf(harness, 'doc-f1')).toEqual(OWNER_ONLY);
        expect(harness.ingests.map((entry) => entry.options.accessKeys)).toEqual([OWNER_ONLY]);
        expect(labelOf(harness, 'doc-f2')).toEqual([`g:${GROUP_A}`]);
    });

    it('Notion pages by id: workspace read once per sync, unchanged pages re-mapped before the skip', async () => {
        mapping.groups.set('notion:workspace:ws-loops', GROUP_A);
        remote.notionPages = {
            p1: { object: 'page', id: 'p1', last_edited_time: MODIFIED, public_url: null, properties: {} },
            p2: { object: 'page', id: 'p2', last_edited_time: MODIFIED, public_url: 'https://example-site.notion.site/p2', properties: {} },
        };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('notion', null, ['p1', 'p2'])],
            nango_sync_records: [syncedRecord('p1', 'doc-p1')],
            documents: [syncedDocument('doc-p1', 'p1', ['all'])],
        });

        const stats = await syncDocumentsForConnection(CONNECTION, 'notion');

        expect(getConnection).toHaveBeenCalledTimes(1);
        expect(stats).toMatchObject({ skipped: 1, processed: 1, failClosed: 1 });
        expect(labelOf(harness, 'doc-p1')).toEqual([`g:${GROUP_A}`]);
        expect(labelOf(harness, 'doc-p2')).toEqual(OWNER_ONLY);
        expect(harness.ingests.map((entry) => entry.options.accessKeys)).toEqual([OWNER_ONLY]);
    });

    it('Notion top-level page with children: every page gets the step; a missing workspace id closes them all', async () => {
        remote.notionRaw = {};
        remote.notionPages = {
            top: { object: 'page', id: 'top', last_edited_time: MODIFIED, public_url: null, properties: {} },
            child: { object: 'page', id: 'child', last_edited_time: MODIFIED, public_url: null, properties: {} },
        };
        remote.notionChildren = { top: [{ id: 'child', type: 'child_page', child_page: { title: 'Child' }, last_edited_time: MODIFIED }] };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('notion', 'top-level-mode', ['top'])],
            nango_sync_records: [syncedRecord('top', 'doc-top'), syncedRecord('child', 'doc-child')],
            documents: [syncedDocument('doc-top', 'top', ['all']), syncedDocument('doc-child', 'child', ['all'])],
        });

        const stats = await syncDocumentsForConnection(CONNECTION, 'notion');

        expect(stats).toMatchObject({ skipped: 2, failClosed: 2 });
        expect(labelOf(harness, 'doc-top')).toEqual(OWNER_ONLY);
        expect(labelOf(harness, 'doc-child')).toEqual(OWNER_ONLY);
        expect(harness.applied.every((entry) => entry.status === 'source_error')).toBe(true);
        expect(getConnection).toHaveBeenCalledTimes(1);
    });

    it('generic loop (Dropbox folder): unchanged files are re-mapped, the shared folder is read, new files go in owner-only', async () => {
        mapping.groups.set('dropbox:group:g:team-a', GROUP_A);
        remote.dropboxEntries = [
            { '.tag': 'file', id: 'id:d1', name: 'd1.txt', path_display: '/d1.txt', client_modified: MODIFIED, sharing_info: { read_only: false, parent_shared_folder_id: 'sf-1' } },
            { '.tag': 'file', id: 'id:d2', name: 'd2.txt', path_display: '/d2.txt', client_modified: MODIFIED },
        ];
        const groupMembers = { users: [], groups: [{ access_type: { '.tag': 'viewer' }, group: { group_id: 'g:team-a', group_name: 'Team' } }], invitees: [] };
        remote.dropboxMembers = { 'id:d1': groupMembers, 'id:d2': groupMembers };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('dropbox', '/folder')],
            nango_sync_records: [syncedRecord('id:d1', 'doc-d1')],
            documents: [syncedDocument('doc-d1', 'id:d1', ['all'])],
        });

        const stats = await syncDocumentsForConnection(CONNECTION, 'dropbox');
        const folderCalls = remote.calls.filter((call) => call.endpoint === '/2/sharing/list_folder_members');

        expect(stats).toMatchObject({ skipped: 1, processed: 1, failClosed: 0 });
        expect(folderCalls.map((call) => call.data?.shared_folder_id)).toEqual(['sf-1']);
        expect(labelOf(harness, 'doc-d1')).toEqual([`g:${GROUP_A}`]);
        expect(labelOf(harness, 'doc-id:d2')).toEqual([`g:${GROUP_A}`]);
        expect(harness.ingests.map((entry) => entry.options.accessKeys)).toEqual([OWNER_ONLY]);
    });

    it('generic multi-folder loop: unchanged files get the step before the skip', async () => {
        remote.dropboxEntries = [{ '.tag': 'file', id: 'id:m1', name: 'm1.txt', path_display: '/a/m1.txt', client_modified: MODIFIED }];
        remote.dropboxMembers = { 'id:m1': { users: [], groups: [{ group: { group_id: 'g:unmapped' } }], invitees: [] } };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('dropbox', 'multi-folder-mode', ['/a'])],
            nango_sync_records: [syncedRecord('id:m1', 'doc-m1')],
            documents: [syncedDocument('doc-m1', 'id:m1', ['all'])],
        });

        const stats = await syncDocumentsForConnection(CONNECTION, 'dropbox');

        expect(stats).toMatchObject({ skipped: 1, failClosed: 1 });
        expect(labelOf(harness, 'doc-m1')).toEqual(OWNER_ONLY);
    });

    it('never relabels a document that is not this file\'s connector copy', async () => {
        remote.files = [driveFile('f1')];
        remote.permissions.f1 = [{ id: 'p-anyone', type: 'anyone', role: 'reader' }];
        mapping.rules.add('google-drive:anyone:');
        const { syncDocumentsForConnection, harness } = await loadSyncManager({
            nango_connections: [connection('google-drive', FOLDER)],
            nango_sync_records: [syncedRecord('f1', 'doc-upload')],
            documents: [{ id: 'doc-upload', tenant_key: 's:default', user_id: MEMBER, source: 'upload', source_file_id: null, access_groups: [`g:${GROUP_A}`] }],
        });

        await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect(labelOf(harness, 'doc-upload')).toEqual([`g:${GROUP_A}`]);
        expect(harness.applied.map((entry) => entry.documentId)).not.toContain('doc-upload');
    });

    it('single-tenant canary: mapped group, unmapped group and unruled domain sharing, then the domain rule (DATA-22 criterion 4)', async () => {
        remote.files = [driveFile('c1'), driveFile('c2'), driveFile('c3')];
        remote.permissions = { c1: [groupShare('team-a@example.test')], c2: [groupShare('team-x@example.test')], c3: [domainShare] };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({ nango_connections: [connection('google-drive', FOLDER)] });

        const first = await syncDocumentsForConnection(CONNECTION, 'google-drive');
        expect(first).toMatchObject({ processed: 3, failClosed: 2 });
        expect([labelOf(harness, 'doc-c1'), labelOf(harness, 'doc-c2'), labelOf(harness, 'doc-c3')]).toEqual([[`g:${GROUP_A}`], OWNER_ONLY, OWNER_ONLY]);

        mapping.rules.add('google-drive:domain:example.test');
        const second = await syncDocumentsForConnection(CONNECTION, 'google-drive');
        expect(second).toMatchObject({ skipped: 3, failClosed: 1 });
        expect(labelOf(harness, 'doc-c3')).toEqual(['all']);
    });

    it('multi-tenant: arrays are computed in the owner personal tenant', async () => {
        remote.files = [driveFile('c1')];
        remote.permissions = { c1: [groupShare('team-a@example.test')] };
        const { syncDocumentsForConnection, harness } = await loadSyncManager({ nango_connections: [connection('google-drive', FOLDER)] }, { deploymentMode: 'multi-tenant' });

        await syncDocumentsForConnection(CONNECTION, 'google-drive');

        expect((harness.memory.tables.documents ?? []).find((row) => row.id === 'doc-c1')?.tenant_key).toBe(`u:${OWNER}`);
        expect(labelOf(harness, 'doc-c1')).toEqual([`g:${GROUP_A}`]);
    });

    it('writes the arrays with RAG_DOC_ACCESS_GROUPS off (D-22)', async () => {
        vi.stubEnv('RAG_DOC_ACCESS_GROUPS', 'off');
        try {
            remote.files = [driveFile('c1')];
            remote.permissions = { c1: [groupShare('team-x@example.test')] };
            const { syncDocumentsForConnection, harness } = await loadSyncManager({ nango_connections: [connection('google-drive', FOLDER)] }, { pipeline: 'legacy' });
            const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');
            expect(stats.failClosed).toBe(1);
            expect(harness.ingests.map((entry) => entry.options.accessKeys)).toEqual([OWNER_ONLY]);
            expect(labelOf(harness, 'doc-c1')).toEqual(OWNER_ONLY);
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe('POST /api/nango/sync answer', () => {
    afterEach(() => {
        vi.resetModules();
        for (const name of ['@/lib/nango/client', '@/lib/nango/sync-manager', '@/lib/supabase', '@/lib/supabase/server']) vi.doUnmock(name);
    });

    async function post(stats: Row) {
        vi.resetModules();
        const admin = {
            from: () => {
                const builder: Record<string, unknown> = {
                    select: () => builder,
                    update: () => builder,
                    eq: () => builder,
                    single: async () => ({ data: { user_id: OWNER, connection_id: CONNECTION }, error: null }),
                    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
                };
                return builder;
            },
        };
        vi.doMock('@/lib/nango/client', () => ({ isNangoEnabled: () => true, getNango: () => ({ triggerSync: async () => undefined }) }));
        vi.doMock('@/lib/nango/sync-manager', () => ({ syncDocumentsForConnection: async () => stats }));
        vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin }));
        vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: OWNER } }, error: null }) } }) }));
        const { POST } = await import('@/app/api/nango/sync/route');
        const { NextRequest } = await import('next/server');
        const response = await POST(
            new NextRequest('http://localhost/api/nango/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: CONNECTION, provider: 'google-drive' }) }),
        );
        return response.json();
    }

    it('carries the number of documents left with the fallback audience', async () => {
        await expect(post({ processed: 1, failed: 0, skipped: 0, deleted: 0, failClosed: 2 })).resolves.toMatchObject({ failClosed: 2 });
        await expect(post({ processed: 1, failed: 0, skipped: 0, deleted: 0 })).resolves.toMatchObject({ failClosed: 0 });
    });
});
