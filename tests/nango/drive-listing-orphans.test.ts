import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

const OWNER = TWO_TENANT_IDS.userA;
const OTHER = TWO_TENANT_IDS.userB;
const CONNECTION = 'conn-pages';
const FOLDER = 'folder-pages';
const TENANT = `u:${OWNER}`;
const LINEAGE = (n: number) => `00000000-0000-4000-8000-00000000f${String(n).padStart(3, '0')}`;

type Row = Record<string, unknown>;

interface ProxyRequest {
  connectionId: string;
  params?: Record<string, string>;
}

const remote = {
  pages: {} as Record<string, Array<Row[] | 'fail'>>,
  endless: false,
  calls: [] as ProxyRequest[],
};

const proxy = vi.fn(async (request: ProxyRequest) => {
  remote.calls.push(request);
  const folder = /'([^']+)' in parents/.exec(request.params?.q ?? '')?.[1] ?? '';
  const pages = remote.pages[folder] ?? [[]];
  const token = request.params?.pageToken;
  const index = token ? Number(token.replace('tok-', '')) : 0;
  if (remote.endless) return { data: { files: [{ id: `endless-${index}`, name: 'e.bin', mimeType: 'application/octet-stream' }], nextPageToken: `tok-${index + 1}` } };
  const page = pages[index];
  if (page === 'fail') throw new Error('proxy down');
  return { data: { files: page ?? [], ...(index + 1 < pages.length ? { nextPageToken: `tok-${index + 1}` } : {}) } };
});

const file = (id: string): Row => ({ id, name: `${id}.bin`, mimeType: 'application/octet-stream' });

function createMemoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { nango_connections: [], nango_sync_records: [], documents: [], document_chunks: [], ...seed };
  function from(table: string) {
    let op = 'select' as 'select' | 'delete';
    const filters: Array<{ kind: string; column: string; value: unknown }> = [];
    const match = (row: Row) =>
      filters.every((entry) => (entry.kind === 'eq' ? row[entry.column] === entry.value : (entry.value as unknown[]).includes(row[entry.column])));
    const builder = {
      select: () => builder,
      delete() {
        op = 'delete';
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ kind: 'eq', column, value });
        return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push({ kind: 'in', column, value });
        return builder;
      },
      single() {
        const found = (tables[table] ?? []).filter(match)[0];
        return Promise.resolve({ data: found ?? null, error: found ? null : { message: 'not found' } });
      },
      then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) => {
        const rows = tables[table] ?? [];
        const matched = rows.filter(match);
        if (op === 'delete') tables[table] = rows.filter((row) => !matched.includes(row));
        return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }
  return { tables, admin: { from }, documentIds: () => (tables.documents ?? []).map((row) => row.id).sort() };
}

async function loadSyncManager(memory: ReturnType<typeof createMemoryDb>) {
  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memory.admin }));
  vi.doMock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords: vi.fn() }) }));
  vi.doMock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn() }));
  vi.doMock('@/lib/document-processor', () => ({ processDocument: vi.fn() }));
  vi.doMock('@/lib/nango/document-adapter', () => ({ processDocumentWithMetadata: vi.fn(), nangoPipeline: () => 'unified' }));
  vi.doMock('@/lib/rag/ingest/queue-config', () => ({ queueConfigFromProcessEnv: () => ({ ingestAsync: false }), resetQueueConfigForTests: () => {} }));
  vi.doMock('@/lib/rag', () => ({
    ingest: vi.fn(),
    buildSourceKey: identity.buildSourceKey,
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    currentIngestConfig: () => ({ pipeline: 'unified' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage: vi.fn(),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
  }));
  return import('@/lib/nango/sync-manager');
}

function connection(syncFolder: string, syncFileIds: string[] | null = null): Row {
  return { id: `row-${CONNECTION}`, connection_id: CONNECTION, user_id: OWNER, provider: 'google-drive', sync_folder_id: syncFolder, sync_file_ids: syncFileIds };
}

function record(id: string, fileId: string, documentId: string): Row {
  return { id, user_id: OWNER, connection_id: CONNECTION, file_id: fileId, file_name: `${fileId}.bin`, document_id: documentId, status: 'completed' };
}

function document(id: string, fileId: string, lineage: string, extra: Row = {}): Row {
  return { id, lineage_id: lineage, version: 1, tenant_key: TENANT, user_id: OWNER, source: 'nango', source_connection_id: CONNECTION, source_file_id: fileId, source_key: fileId, ...extra };
}

describe('Google Drive listing and orphan deletion', () => {
  beforeEach(() => {
    remote.pages = {};
    remote.endless = false;
    remote.calls = [];
    proxy.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/nango/client');
    vi.doUnmock('@/lib/nango/file-fetcher');
    vi.doUnmock('@/lib/document-processor');
    vi.doUnmock('@/lib/nango/document-adapter');
    vi.doUnmock('@/lib/rag');
    vi.doUnmock('@/lib/rag/ingest/queue-config');
  });

  const seed = () =>
    createMemoryDb({
      nango_connections: [connection(FOLDER)],
      nango_sync_records: [record('rec-1', 'f1', 'doc-1'), record('rec-2', 'f2', 'doc-2'), record('rec-gone', 'gone', 'doc-gone')],
      documents: [
        document('doc-1', 'f1', LINEAGE(1)),
        document('doc-2', 'f2', LINEAGE(2)),
        document('doc-gone', 'gone', LINEAGE(3)),
        document('doc-other', 'gone', LINEAGE(4), { tenant_key: `u:${OTHER}`, user_id: OTHER, source_connection_id: 'conn-other' }),
      ],
    });

  it('reads every page, so a file on page two is not an orphan, and still deletes the file that is gone', async () => {
    remote.pages[FOLDER] = [[file('f1')], [file('f2')]];
    const memory = seed();
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(remote.calls.map((call) => call.params?.pageToken)).toEqual([undefined, 'tok-1']);
    expect(remote.calls[0]?.params?.fields).toContain('nextPageToken');
    expect(stats.deleted).toBe(1);
    expect(memory.documentIds()).toEqual(['doc-1', 'doc-2', 'doc-other']);
    expect((memory.tables.nango_sync_records ?? []).map((row) => row.file_id).sort()).toEqual(['f1', 'f2']);
  });

  it('deletes nothing when a later page fails, and the sync still finishes', async () => {
    remote.pages[FOLDER] = [[file('f1')], 'fail'];
    const memory = seed();
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(0);
    expect(memory.documentIds()).toEqual(['doc-1', 'doc-2', 'doc-gone', 'doc-other']);
    expect(memory.tables.nango_sync_records).toHaveLength(3);
  });

  it('deletes nothing when the listing never ends and is cut at the page limit', async () => {
    remote.endless = true;
    const memory = seed();
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(remote.calls.length).toBeLessThanOrEqual(200);
    expect(stats.deleted).toBe(0);
    expect(memory.documentIds()).toEqual(['doc-1', 'doc-2', 'doc-gone', 'doc-other']);
  });

  it('still fails the whole sync when the first page fails, and deletes nothing', async () => {
    remote.pages[FOLDER] = ['fail'];
    const memory = seed();
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    await expect(syncDocumentsForConnection(CONNECTION, 'google-drive')).rejects.toThrow();
    expect(memory.documentIds()).toEqual(['doc-1', 'doc-2', 'doc-gone', 'doc-other']);
  });

  it('multi-folder: a folder that fails to list stops orphan deletion for the run', async () => {
    remote.pages['folder-ok'] = [[file('f1')]];
    remote.pages['folder-bad'] = ['fail'];
    const memory = seed();
    memory.tables.nango_connections = [connection('multi-folder-mode', ['folder-ok', 'folder-bad'])];
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(0);
    expect(memory.documentIds()).toEqual(['doc-1', 'doc-2', 'doc-gone', 'doc-other']);
  });

  it('multi-folder: complete listings across folders delete only the file that is gone', async () => {
    remote.pages['folder-a'] = [[file('f1')], [file('f2')]];
    remote.pages['folder-b'] = [[]];
    const memory = seed();
    memory.tables.nango_connections = [connection('multi-folder-mode', ['folder-a', 'folder-b'])];
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(1);
    expect(memory.documentIds()).toEqual(['doc-1', 'doc-2', 'doc-other']);
  });
});
