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
});
