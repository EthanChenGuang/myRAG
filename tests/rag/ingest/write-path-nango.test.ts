import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { createPgliteAdmin } from '../../helpers/pglite-admin';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';
import type { IngestInput, IngestResult, TenantScope } from '@/lib/rag';

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const FILE_ID = 'drive-file-1';
const CONNECTION = 'conn-a';
const FOLDER = 'folder-1';

const state = {
  pipeline: 'legacy' as 'legacy' | 'unified',
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  configThrows: false,
  ingestResults: [] as IngestResult[],
  scopeKey: ((): string => '') as (scope: TenantScope) => string,
};

const processDocument = vi.fn();
const ingest = vi.fn();

function result(partial: Partial<IngestResult> & Pick<IngestResult, 'status'>): IngestResult {
  return { documentId: null, version: null, parserUsed: 'text', chunkCount: 0, warnings: [], ...partial };
}

async function loadAdapter() {
  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  vi.doMock('@/lib/document-processor', () => ({ processDocument }));
  vi.doMock('@/lib/rag', () => ({
    ingest,
    buildSourceKey: identity.buildSourceKey,
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: state.mode }),
    currentIngestConfig: () => {
      if (state.configThrows) throw new Error('config unavailable');
      return { pipeline: state.pipeline };
    },
  }));
  const scope = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  state.scopeKey = scope.scopeKey;
  return import('@/lib/nango/document-adapter');
}

beforeEach(() => {
  state.pipeline = 'legacy';
  state.mode = 'multi-tenant';
  state.configThrows = false;
  state.ingestResults = [];
  processDocument.mockReset();
  ingest.mockReset();
  ingest.mockImplementation(async () => state.ingestResults.shift() ?? result({ status: 'ready', documentId: 'doc-default', version: 1 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/document-processor');
  vi.doUnmock('@/lib/rag');
});

function ingestInput(call = 0): IngestInput {
  return ingest.mock.calls[call][0] as IngestInput;
}

const baseOptions = {
  userId: OWNER_A,
  source: 'nango' as const,
  sourceProvider: 'google-drive',
  sourceFileId: FILE_ID,
  sourceConnectionId: CONNECTION,
  nangoConnectionId: CONNECTION,
  nangoFolderId: FOLDER,
  mimeType: 'application/pdf',
};

describe('nango document adapter, legacy pipeline', () => {
  it('sends today\'s metadata to processDocument and never calls ingest', async () => {
    processDocument.mockResolvedValue('doc-legacy');
    const { processDocumentWithMetadata } = await loadAdapter();
    const buffer = Buffer.from('legacy bytes');

    const id = await processDocumentWithMetadata('Report.pdf', buffer, baseOptions);

    expect(id).toBe('doc-legacy');
    expect(processDocument).toHaveBeenCalledTimes(1);
    const [filename, passed, metadata] = processDocument.mock.calls[0];
    expect(filename).toBe('Report.pdf');
    expect(passed).toBe(buffer);
    expect(metadata).toEqual({
      user_id: OWNER_A,
      source: 'nango',
      source_provider: 'google-drive',
      source_file_id: FILE_ID,
      source_connection_id: CONNECTION,
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('stays legacy when the ingest configuration cannot be read', async () => {
    state.pipeline = 'unified';
    state.configThrows = true;
    processDocument.mockResolvedValue('doc-legacy');
    const { processDocumentWithMetadata, nangoPipeline } = await loadAdapter();

    expect(nangoPipeline()).toBe('legacy');
    await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions);
    expect(processDocument).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });
});

describe('nango document adapter, unified pipeline', () => {
  beforeEach(() => {
    state.pipeline = 'unified';
  });

  it('multi-tenant: ingests in the owner personal scope with the provider file id as identity and returns the version id', async () => {
    state.ingestResults = [result({ status: 'ready', documentId: 'doc-v1', version: 1 })];
    const { processDocumentWithMetadata } = await loadAdapter();
    const buffer = Buffer.from('%PDF-1.4 body');

    const id = await processDocumentWithMetadata('Report.pdf', buffer, baseOptions);

    expect(id).toBe('doc-v1');
    expect(processDocument).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(1);
    const input = ingestInput();
    expect(state.scopeKey(input.scope)).toBe(`u:${OWNER_A}`);
    expect(input).toMatchObject({
      source: 'nango',
      sourceKey: FILE_ID,
      filename: 'Report.pdf',
      mimeType: 'application/pdf',
      options: {
        origin: { sourceProvider: 'google-drive', sourceFileId: FILE_ID, sourceConnectionId: CONNECTION },
        nangoConnectionId: CONNECTION,
        nangoFolderId: FOLDER,
      },
    });
    expect(input.file).toBe(buffer);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it('single-tenant: ingests in the s:default scope', async () => {
    state.mode = 'single-tenant';
    const { processDocumentWithMetadata } = await loadAdapter();

    await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), { ...baseOptions, userId: 'single-tenant-user' });

    expect(state.scopeKey(ingestInput().scope)).toBe('s:default');
  });

  it('refuses an owner that is not a UUID in multi-tenant mode: typed error, ingest never called', async () => {
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    for (const owner of ['single-tenant-user', '', 'null', 'a1']) {
      const failure = await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), { ...baseOptions, userId: owner }).catch((error) => error);
      expect(failure).toBeInstanceOf(NangoIngestError);
      expect(failure.reason).toBe('invalid_owner');
      expect(failure.status).toBe(503);
    }
    expect(ingest).not.toHaveBeenCalled();
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('refuses a file without a provider file id', async () => {
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    const failure = await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), { ...baseOptions, sourceFileId: undefined }).catch((error) => error);

    expect(failure).toBeInstanceOf(NangoIngestError);
    expect(failure.reason).toBe('missing_file_id');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns the existing current document id when the file is an unchanged duplicate', async () => {
    state.ingestResults = [result({ status: 'skipped_duplicate', duplicateOf: 'doc-current' })];
    const { processDocumentWithMetadata } = await loadAdapter();

    expect(await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions)).toBe('doc-current');
  });

  it('throws a typed error for a failed ingest and for one that is still processing', async () => {
    state.ingestResults = [
      result({ status: 'failed', documentId: 'doc-x', reason: 'parse_failed' }),
      result({ status: 'processing', documentId: 'doc-y', reason: 'deadline' }),
    ];
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    const failed = await processDocumentWithMetadata('A.pdf', Buffer.from('x'), baseOptions).catch((error) => error);
    const pending = await processDocumentWithMetadata('B.pdf', Buffer.from('y'), baseOptions).catch((error) => error);

    expect(failed).toBeInstanceOf(NangoIngestError);
    expect(failed.reason).toBe('parse_failed');
    expect(pending).toBeInstanceOf(NangoIngestError);
    expect(pending.reason).toBe('deadline');
  });

  it('records a quarantined file under its document id without throwing', async () => {
    state.ingestResults = [result({ status: 'quarantined', documentId: 'doc-q', version: 1 })];
    const { processDocumentWithMetadata } = await loadAdapter();

    expect(await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions)).toBe('doc-q');
  });

  it('names exported Google documents and extensionless text pages after the bytes that are stored', async () => {
    const { processDocumentWithMetadata } = await loadAdapter();

    await processDocumentWithMetadata('Quarterly plan', Buffer.from('%PDF-1.4'), { ...baseOptions, mimeType: 'application/vnd.google-apps.document' });
    await processDocumentWithMetadata('Plan v1.2', Buffer.from('notes'), { ...baseOptions, sourceProvider: 'notion', mimeType: 'text/plain' });
    await processDocumentWithMetadata('Notes.txt', Buffer.from('notes'), { ...baseOptions, mimeType: undefined });

    expect(ingestInput(0)).toMatchObject({ filename: 'Quarterly plan.pdf', mimeType: 'application/pdf' });
    expect(ingestInput(1)).toMatchObject({ filename: 'Plan v1.2.txt', mimeType: 'text/plain' });
    expect(ingestInput(2)).toMatchObject({ filename: 'Notes.txt', mimeType: 'text/plain' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Sync manager
// ---------------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in' | 'is'; column: string; value: unknown };
interface LoggedOp {
  table: string;
  op: 'select' | 'upsert' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
}

/** An in-memory supabase-js style client that honours eq, in and is filters and logs every operation with its filters. */
function createMemoryDb(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((row) => ({ ...row }));
  const ops: LoggedOp[] = [];
  const failSelect = new Set<string>();
  let counter = 0;

  function from(table: string) {
    tables[table] ??= [];
    let op: LoggedOp['op'] = 'select';
    let payload: Row = {};
    let conflict: string[] = [];
    const filters: Filter[] = [];
    const matches = (row: Row) =>
      filters.every((filter) => {
        if (filter.kind === 'eq') return row[filter.column] === filter.value;
        if (filter.kind === 'is') return (row[filter.column] ?? null) === filter.value;
        return (filter.value as unknown[]).includes(row[filter.column]);
      });

    const execute = (mode: 'many' | 'single'): { data: unknown; error: { code: string; message: string } | null } => {
      ops.push({ table, op, filters: filters.map((filter) => [filter.column, filter.value]) });
      const rows = tables[table];
      if (op === 'upsert') {
        const existing = rows.find((row) => conflict.every((column) => row[column] === payload[column]));
        if (existing) Object.assign(existing, payload);
        else rows.push({ id: `${table}-${++counter}`, ...payload });
        return { data: null, error: null };
      }
      if (op === 'update') {
        for (const row of rows.filter(matches)) Object.assign(row, payload);
        return { data: null, error: null };
      }
      if (op === 'delete') {
        tables[table] = rows.filter((row) => !matches(row));
        return { data: null, error: null };
      }
      if (failSelect.has(table)) return { data: null, error: { code: 'XX000', message: 'lookup failed' } };
      const found = rows.filter(matches);
      if (mode === 'single') {
        return found.length === 1
          ? { data: { ...found[0] }, error: null }
          : { data: null, error: { code: 'PGRST116', message: `${found.length} rows` } };
      }
      return { data: found.map((row) => ({ ...row })), error: null };
    };

    const builder = {
      select: () => builder,
      upsert(row: Row, options?: { onConflict?: string }) {
        op = 'upsert';
        payload = row;
        conflict = (options?.onConflict ?? 'id').split(',');
        return builder;
      },
      update(next: Row) {
        op = 'update';
        payload = next;
        return builder;
      },
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
      is(column: string, value: null) {
        filters.push({ kind: 'is', column, value });
        return builder;
      },
      order: () => builder,
      single: () => Promise.resolve(execute('single')),
      maybeSingle: () => Promise.resolve(execute('single')),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(execute('many')).then(onFulfilled, onRejected),
    };
    return builder;
  }

  return {
    tables,
    ops,
    failSelect,
    admin: { from },
    writesTo: (table: string) => ops.filter((entry) => entry.table === table && entry.op !== 'select'),
  };
}

type MemoryDb = ReturnType<typeof createMemoryDb>;

const OWNER_B = '00000000-0000-4000-8000-0000000000b1';
const MODIFIED = '2099-01-01T00:00:00.000Z';

function connection(connectionId: string, userId: string, extra: Row = {}): Row {
  return {
    id: `row-${connectionId}`,
    connection_id: connectionId,
    user_id: userId,
    provider: 'google-drive',
    sync_folder_id: null,
    sync_file_ids: null,
    ...extra,
  };
}

const remote = {
  drive: {} as Record<string, Record<string, Row[]>>,
  driveById: {} as Record<string, Row>,
  dropbox: {} as Record<string, Row[]>,
  notionPages: {} as Record<string, Row>,
  notionChildren: {} as Record<string, Row[]>,
  contents: {} as Record<string, string>,
};

const proxy = vi.fn(async (request: { providerConfigKey: string; connectionId: string; endpoint: string; params?: Record<string, string>; data?: Row }) => {
  const { endpoint } = request;
  if (endpoint === '/drive/v3/files') {
    const folder = /'([^']+)' in parents/.exec(request.params?.q ?? '')?.[1] ?? '';
    return { data: { files: remote.drive[request.connectionId]?.[folder] ?? [] } };
  }
  if (endpoint.startsWith('/drive/v3/files/')) return { data: remote.driveById[endpoint.split('/').pop() as string] };
  if (endpoint === '/2/files/list_folder') return { data: { entries: remote.dropbox[String(request.data?.path ?? '')] ?? [] } };
  if (endpoint.startsWith('/v1/pages/')) return { data: remote.notionPages[endpoint.split('/').pop() as string] };
  if (endpoint.startsWith('/v1/blocks/')) return { data: { results: remote.notionChildren[endpoint.split('/')[3] as string] ?? [] } };
  throw new Error(`unexpected proxy call ${endpoint}`);
});

const fetchFileContent = vi.fn(async (_provider: string, connectionId: string, file: { id: string }) =>
  Buffer.from(remote.contents[`${connectionId}/${file.id}`] ?? `content of ${file.id}`)
);

function driveFile(id: string, extra: Row = {}): Row {
  return { id, name: `${id}.pdf`, mimeType: 'application/pdf', modifiedTime: MODIFIED, ...extra };
}

async function mockSyncDependencies(memory: { admin: unknown }) {
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scope = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  state.scopeKey = scope.scopeKey;
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memory.admin }));
  vi.doMock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords: vi.fn() }) }));
  vi.doMock('@/lib/nango/file-fetcher', () => ({ fetchFileContent }));
  vi.doMock('@/lib/document-processor', () => ({ processDocument }));
  vi.doMock('@/lib/rag', () => ({
    ingest,
    buildSourceKey: identity.buildSourceKey,
    scopeKey: scope.scopeKey,
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: state.mode }),
    currentIngestConfig: () => ({ pipeline: state.pipeline }),
  }));
}

async function loadSyncManager(memory: MemoryDb, options: { adapter: 'real' | 'mock' }) {
  vi.resetModules();
  await mockSyncDependencies(memory);
  if (options.adapter === 'mock') {
    vi.doMock('@/lib/nango/document-adapter', () => ({
      processDocumentWithMetadata: adapterCall,
      nangoPipeline: () => state.pipeline,
    }));
  }
  return import('@/lib/nango/sync-manager');
}

const adapterCall = vi.fn(async (_filename: string, _buffer: Buffer, options: { sourceFileId?: string }) => `doc-${options.sourceFileId}`);

function resetRemote() {
  remote.drive = {};
  remote.driveById = {};
  remote.dropbox = {};
  remote.notionPages = {};
  remote.notionChildren = {};
  remote.contents = {};
  proxy.mockClear();
  fetchFileContent.mockClear();
  adapterCall.mockClear();
}

function adapterOptions(call = 0): Record<string, unknown> {
  return adapterCall.mock.calls[call][2] as unknown as Record<string, unknown>;
}

describe('nango sync manager, legacy pipeline', () => {
  beforeEach(() => {
    resetRemote();
    state.pipeline = 'legacy';
    state.mode = 'multi-tenant';
  });

  afterEach(() => {
    for (const id of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher', '@/lib/document-processor', '@/lib/rag', '@/lib/nango/document-adapter']) {
      vi.doUnmock(id);
    }
  });

  it('syncs a folder through processDocument with today\'s metadata and writes no tenant or lineage filter', async () => {
    const memory = createMemoryDb({ nango_connections: [connection(CONNECTION, OWNER_A, { sync_folder_id: FOLDER })] });
    remote.drive[CONNECTION] = { [FOLDER]: [driveFile('f1')] };
    processDocument.mockResolvedValue('doc-legacy-1');
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'real' });

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats).toMatchObject({ processed: 1, failed: 0, skipped: 0 });
    expect(ingest).not.toHaveBeenCalled();
    expect(processDocument).toHaveBeenCalledTimes(1);
    expect(processDocument.mock.calls[0][2]).toEqual({
      user_id: OWNER_A,
      source: 'nango',
      source_provider: 'google-drive',
      source_file_id: 'f1',
      source_connection_id: CONNECTION,
    });
    expect(memory.tables.nango_sync_records[0]).toMatchObject({ user_id: OWNER_A, file_id: 'f1', document_id: 'doc-legacy-1', status: 'completed' });
    expect(JSON.stringify(memory.ops)).not.toMatch(/tenant_key|lineage_id/);
  });

  it('deletes an orphaned file by document id with the user and source filters it always had, and nothing of another owner', async () => {
    const memory = createMemoryDb({
      nango_connections: [connection(CONNECTION, OWNER_A, { sync_folder_id: FOLDER })],
      nango_sync_records: [
        { id: 'rec-a', user_id: OWNER_A, connection_id: CONNECTION, file_id: 'gone', file_name: 'gone.pdf', document_id: 'doc-a', status: 'completed' },
        { id: 'rec-b', user_id: OWNER_B, connection_id: 'conn-b', file_id: 'gone', file_name: 'gone.pdf', document_id: 'doc-b', status: 'completed' },
      ],
      documents: [
        { id: 'doc-a', user_id: OWNER_A, source: 'nango', source_file_id: 'gone' },
        { id: 'doc-b', user_id: OWNER_B, source: 'nango', source_file_id: 'gone' },
      ],
    });
    remote.drive[CONNECTION] = { [FOLDER]: [] };
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'real' });

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(1);
    expect(memory.tables.documents.map((row) => row.id)).toEqual(['doc-b']);
    expect(memory.tables.nango_sync_records.map((row) => row.id)).toEqual(['rec-b']);
    expect(memory.writesTo('documents')).toEqual([
      { table: 'documents', op: 'delete', filters: [['id', 'doc-a'], ['user_id', OWNER_A], ['source', 'nango']] },
    ]);
  });
});

describe('nango sync manager, call sites under the unified pipeline', () => {
  beforeEach(() => {
    resetRemote();
    state.pipeline = 'unified';
    state.mode = 'multi-tenant';
  });

  afterEach(() => {
    for (const id of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher', '@/lib/document-processor', '@/lib/rag', '@/lib/nango/document-adapter']) {
      vi.doUnmock(id);
    }
  });

  async function sync(provider: string, row: Row, memoryRows: Record<string, Row[]> = {}) {
    const memory = createMemoryDb({ nango_connections: [connection(CONNECTION, OWNER_A, { provider, ...row })], ...memoryRows });
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'mock' });
    const stats = await syncDocumentsForConnection(CONNECTION, provider);
    return { memory, stats };
  }

  it('Google Drive single folder: the connection owner, the connection id, the folder id and the file type', async () => {
    remote.drive[CONNECTION] = { [FOLDER]: [driveFile('f1')] };

    const { memory } = await sync('google-drive', { sync_folder_id: FOLDER });

    expect(adapterCall).toHaveBeenCalledTimes(1);
    expect(adapterOptions()).toEqual({
      userId: OWNER_A,
      source: 'nango',
      sourceProvider: 'google-drive',
      sourceFileId: 'f1',
      sourceConnectionId: CONNECTION,
      nangoConnectionId: CONNECTION,
      nangoFolderId: FOLDER,
      mimeType: 'application/pdf',
    });
    expect(memory.tables.nango_sync_records[0]).toMatchObject({ document_id: 'doc-f1', status: 'completed' });
  });

  it('Google Drive multi-folder: each file carries its own folder id', async () => {
    remote.drive[CONNECTION] = { 'fo-1': [driveFile('f1')], 'fo-2': [driveFile('f2')] };

    await sync('google-drive', { sync_folder_id: 'multi-folder-mode', sync_file_ids: ['fo-1', 'fo-2'] });

    expect(adapterCall.mock.calls.map((call) => [call[2].sourceFileId, adapterOptions(adapterCall.mock.calls.indexOf(call)).nangoFolderId])).toEqual([
      ['f1', 'fo-1'],
      ['f2', 'fo-2'],
    ]);
  });

  it('Google Drive single files: the parent Drive reports is the folder, and no marker value is ever passed as a folder id', async () => {
    remote.driveById.f9 = driveFile('f9', { parents: ['fo-9'] });

    await sync('google-drive', { sync_folder_id: null, sync_file_ids: ['f9'] });

    expect(adapterOptions()).toMatchObject({ sourceFileId: 'f9', nangoConnectionId: CONNECTION, nangoFolderId: 'fo-9' });
  });

  it('Notion pages: the page file type, no folder id for a page picked by id', async () => {
    remote.notionPages.p1 = { properties: { title: { title: [{ plain_text: 'Plan' }] } }, last_edited_time: MODIFIED, url: 'https://example.com/p1' };

    await sync('notion', { sync_folder_id: null, sync_file_ids: ['p1'] });

    expect(adapterOptions()).toMatchObject({ sourceFileId: 'p1', nangoConnectionId: CONNECTION, mimeType: 'text/plain' });
    expect(adapterOptions().nangoFolderId).toBeUndefined();
  });

  it('Notion top-level page: the page and its children carry the top-level page id as folder', async () => {
    remote.notionPages.p0 = { properties: { title: { title: [{ plain_text: 'Top' }] } }, last_edited_time: MODIFIED };
    remote.notionPages.c1 = { properties: { title: { title: [{ plain_text: 'Child' }] } }, last_edited_time: MODIFIED };
    remote.notionChildren.p0 = [{ type: 'child_page', id: 'c1', child_page: { title: 'Child' } }];

    await sync('notion', { sync_folder_id: 'top-level-mode', sync_file_ids: ['p0'] });

    expect(adapterCall.mock.calls.map((call) => call[2].sourceFileId)).toEqual(['p0', 'c1']);
    expect([adapterOptions(0).nangoFolderId, adapterOptions(1).nangoFolderId]).toEqual(['p0', 'p0']);
  });

  it('another provider, single folder: the folder path, or root when none is selected', async () => {
    remote.dropbox['/Docs'] = [{ '.tag': 'file', id: 'id:d1', name: 'd1.pdf', path_display: '/Docs/d1.pdf', client_modified: MODIFIED }];
    remote.dropbox[''] = [{ '.tag': 'file', id: 'id:r1', name: 'r1.pdf', path_display: '/r1.pdf', client_modified: MODIFIED }];

    await sync('dropbox', { sync_folder_id: '/Docs' });
    await sync('dropbox', { sync_folder_id: null });

    expect(adapterCall.mock.calls.map((call) => [call[2].sourceFileId, adapterOptions(adapterCall.mock.calls.indexOf(call)).nangoFolderId])).toEqual([
      ['id:d1', '/Docs'],
      ['id:r1', 'root'],
    ]);
  });

  it('another provider, multi-folder: each file carries the folder it was listed in', async () => {
    remote.dropbox['/A'] = [{ '.tag': 'file', id: 'id:a', name: 'a.pdf', path_display: '/A/a.pdf', client_modified: MODIFIED }];
    remote.dropbox['/B'] = [{ '.tag': 'file', id: 'id:b', name: 'b.pdf', path_display: '/B/b.pdf', client_modified: MODIFIED }];

    const { memory } = await sync('dropbox', { sync_folder_id: 'multi-folder-mode', sync_file_ids: ['/A', '/B'] });

    expect(adapterCall.mock.calls.map((call) => [call[2].sourceFileId, adapterOptions(adapterCall.mock.calls.indexOf(call)).nangoFolderId])).toEqual([
      ['id:a', '/A'],
      ['id:b', '/B'],
    ]);
    // The status the legacy path wrote here violates the table's CHECK constraint; unified writes a value the table accepts.
    expect(memory.tables.nango_sync_records.map((row) => row.status)).toEqual(['completed', 'completed']);
  });
});

describe('nango sync manager, owner and failure handling', () => {
  beforeEach(() => {
    resetRemote();
    state.pipeline = 'unified';
    state.mode = 'multi-tenant';
  });

  afterEach(() => {
    for (const id of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher', '@/lib/document-processor', '@/lib/rag', '@/lib/nango/document-adapter']) {
      vi.doUnmock(id);
    }
  });

  it('a connection id with no row fails the sync before anything is fetched, ingested or deleted', async () => {
    const memory = createMemoryDb({ nango_connections: [connection('other', OWNER_B)] });
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'mock' });

    await expect(syncDocumentsForConnection(CONNECTION, 'google-drive')).rejects.toThrow('Connection not found');

    expect(proxy).not.toHaveBeenCalled();
    expect(adapterCall).not.toHaveBeenCalled();
    expect(memory.ops.filter((entry) => entry.op !== 'select')).toEqual([]);
  });

  it('a lookup error fails the sync the same way', async () => {
    const memory = createMemoryDb({ nango_connections: [connection(CONNECTION, OWNER_A, { sync_folder_id: FOLDER })] });
    memory.failSelect.add('nango_connections');
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'mock' });

    await expect(syncDocumentsForConnection(CONNECTION, 'google-drive')).rejects.toThrow('Connection not found');

    expect(proxy).not.toHaveBeenCalled();
    expect(adapterCall).not.toHaveBeenCalled();
    expect(memory.ops.filter((entry) => entry.op !== 'select')).toEqual([]);
  });

  it('a row whose owner cannot be a tenant (not a UUID in multi-tenant mode) fails the sync before anything is fetched or written', async () => {
    const memory = createMemoryDb({
      nango_connections: [connection(CONNECTION, 'single-tenant-user', { sync_folder_id: FOLDER })],
      nango_sync_records: [{ id: 'rec', user_id: 'single-tenant-user', connection_id: CONNECTION, file_id: 'gone', file_name: 'gone.pdf', document_id: 'doc-x', status: 'completed' }],
    });
    remote.drive[CONNECTION] = { [FOLDER]: [] };
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'mock' });

    await expect(syncDocumentsForConnection(CONNECTION, 'google-drive')).rejects.toThrow(/owner/i);

    expect(proxy).not.toHaveBeenCalled();
    expect(adapterCall).not.toHaveBeenCalled();
    expect(memory.ops.filter((entry) => entry.op !== 'select')).toEqual([]);
  });

  it('the sync takes its owner from the connection row only: syncDocumentsForConnection has no owner parameter', async () => {
    const memory = createMemoryDb({ nango_connections: [connection(CONNECTION, OWNER_A, { sync_folder_id: FOLDER })] });
    remote.drive[CONNECTION] = { [FOLDER]: [driveFile('f1')] };
    const { syncDocumentsForConnection } = await loadSyncManager(memory, { adapter: 'mock' });

    expect(syncDocumentsForConnection.length).toBe(2);
    await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(adapterOptions().userId).toBe(OWNER_A);
    const connectionRead = memory.ops.find((entry) => entry.table === 'nango_connections');
    expect(connectionRead?.filters).toEqual([['connection_id', CONNECTION]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Two owners against a real database: real ingest(), real documents, chunks and lineages, fake Nango.
// ---------------------------------------------------------------------------------------------------------------------

const { userA, userB } = TWO_TENANT_IDS;
const CONN_A = 'conn-owner-a';
const CONN_B = 'conn-owner-b';
const SHARED_FILE_ID = 'shared-provider-file-id';
const OLD = '2000-01-01T00:00:00.000Z';

interface DocumentRow {
  id: string;
  lineage_id: string;
  version: number;
  is_current: boolean;
  status: string;
  tenant_key: string;
  user_id: string | null;
  source: string;
  source_key: string;
  source_file_id: string | null;
  source_connection_id: string | null;
  doc_type: string;
  doc_type_origin: string;
  chunks: number;
}

async function documentRows(db: PGlite): Promise<DocumentRow[]> {
  const { rows } = await db.query<DocumentRow>(
    `SELECT d.id, d.lineage_id, d.version, d.is_current, d.status, d.tenant_key, d.user_id, d.source, d.source_key, d.source_file_id,
            d.source_connection_id, d.doc_type, d.doc_type_origin,
            (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks
       FROM documents d WHERE d.source = 'nango' ORDER BY d.tenant_key, d.source_key, d.version`,
  );
  return rows;
}

describe('nango sync against two owners with real ingest', () => {
  let fixture: RouteFixture;
  let db: PGlite;
  let memory: MemoryDb;
  let sync: (connectionId: string, provider?: string) => Promise<{ processed: number; failed: number; skipped: number; deleted: number }>;
  let ingestSpy: ReturnType<typeof vi.spyOn>;
  let rag: typeof import('@/lib/rag');

  function setFiles(connectionId: string, files: Row[], contents: Record<string, string>, folder = FOLDER) {
    remote.drive[connectionId] = { [folder]: files };
    for (const [fileId, text] of Object.entries(contents)) remote.contents[`${connectionId}/${fileId}`] = text;
  }

  function textFile(id: string, modified = MODIFIED): Row {
    return { id, name: `${id}.txt`, mimeType: 'text/plain', modifiedTime: modified };
  }

  function recordsOf(userId: string): Row[] {
    return memory.tables.nango_sync_records.filter((row) => row.user_id === userId);
  }

  async function snapshot(tenantKey: string) {
    const documents = (await documentRows(db)).filter((row) => row.tenant_key === tenantKey);
    const { rows: chunkRows } = await db.query<{ id: string }>(
      `SELECT c.id FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.tenant_key = $1 AND d.source = 'nango' ORDER BY c.id`,
      [tenantKey],
    );
    return { documents, chunkIds: chunkRows.map((row) => row.id), records: JSON.parse(JSON.stringify(recordsOf(tenantKey.slice(2)))) as Row[] };
  }

  beforeAll(async () => {
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      seed: async (database) => {
        db = database;
      },
    });
    process.env.RAG_INGEST_PIPELINE = 'unified';
  });

  afterAll(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    resetRemote();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.exec(`DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE source = 'nango'); DELETE FROM documents WHERE source = 'nango'`);
    await db.exec(`DELETE FROM rag_doc_type_defaults`);

    memory = createMemoryDb({
      nango_connections: [
        connection(CONN_A, userA, { sync_folder_id: FOLDER }),
        connection(CONN_B, userB, { sync_folder_id: FOLDER }),
        connection('conn-defaults', userA, { sync_folder_id: 'folder-contracts' }),
      ],
    });
    const pglite = createPgliteAdmin(db);
    // The Nango tables live in memory, documents and chunks in the real database.
    const real = (await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase')).getSupabaseAdmin();
    if (!real) throw new Error('fixture admin client missing');
    const admin = {
      // ingest() reaches the database through the same admin client: its RPCs go to the fixture edge.
      rpc: real.rpc.bind(real),
      storage: real.storage,
      from(table: string) {
        if (table.startsWith('nango_')) return memory.admin.from(table);
        const builder = pglite.from(table) as unknown as Record<string, unknown>;
        builder.single = () => (builder.maybeSingle as () => Promise<unknown>)();
        return builder;
      },
    };

    vi.resetModules();
    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin }));
    vi.doMock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords: vi.fn() }) }));
    vi.doMock('@/lib/nango/file-fetcher', () => ({ fetchFileContent }));
    rag = await import('@/lib/rag');
    ingestSpy = vi.spyOn(rag, 'ingest');
    const manager = await import('@/lib/nango/sync-manager');
    sync = (connectionId, provider = 'google-drive') => manager.syncDocumentsForConnection(connectionId, provider);

    const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    setIngestDepsForTests({ embedDocuments: async (texts) => texts.map((text) => embedText(text)) });
    const { setObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
    const { createFakeObjectStore } = await import('../../helpers/fake-object-store');
    setObjectStoreForTests(createFakeObjectStore());
  });

  afterEach(async () => {
    const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
    const { resetObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
    resetIngestDepsForTests();
    resetObjectStoreForTests();
    for (const id of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher']) vi.doUnmock(id);
  });

  function scopesOfIngestCalls(): string[] {
    return (ingestSpy.mock.calls as unknown as Array<[IngestInput]>).map((call) => rag.scopeKey(call[0].scope));
  }

  it('ingests a synced file into the owner personal tenant only, as a ready current chunked document', async () => {
    setFiles(CONN_A, [textFile('notes')], { notes: 'The lighthouse keeper logs the tide at dawn.\n\nThe logbook is signed at dusk.' });

    const stats = await sync(CONN_A);

    expect(stats).toMatchObject({ processed: 1, failed: 0 });
    const rows = await documentRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_key: `u:${userA}`,
      user_id: userA,
      source: 'nango',
      source_key: 'notes',
      source_file_id: 'notes',
      source_connection_id: CONN_A,
      status: 'ready',
      is_current: true,
      version: 1,
    });
    expect(rows[0].chunks).toBeGreaterThanOrEqual(1);
    expect(recordsOf(userA)).toEqual([expect.objectContaining({ file_id: 'notes', document_id: rows[0].id, status: 'completed' })]);
    expect(recordsOf(userB)).toEqual([]);
    expect(await documentRows(db).then((all) => all.filter((row) => row.tenant_key === `u:${userB}`))).toEqual([]);
  });

  it('an unchanged file is skipped, a changed one becomes a new version, and the sync record always names the current version', async () => {
    setFiles(CONN_A, [textFile('notes', OLD)], { notes: 'First edition of the harbour notes.\n\nSecond paragraph.' });
    await sync(CONN_A);
    const [v1] = await documentRows(db);

    // Nothing changed: the second sync skips the file without calling ingest.
    ingestSpy.mockClear();
    expect(await sync(CONN_A)).toMatchObject({ processed: 0, skipped: 1 });
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(recordsOf(userA)[0].document_id).toBe(v1.id);

    // Modified at the source, same bytes: ingest reports a duplicate and the record keeps pointing at the current version.
    remote.drive[CONN_A][FOLDER] = [textFile('notes', MODIFIED)];
    expect(await sync(CONN_A)).toMatchObject({ processed: 1, failed: 0 });
    expect((await documentRows(db)).map((row) => [row.version, row.is_current])).toEqual([[1, true]]);
    expect(recordsOf(userA)[0].document_id).toBe(v1.id);

    // New bytes: version 2 of the same lineage, version 1 no longer current, the record follows.
    remote.contents[`${CONN_A}/notes`] = 'Second edition of the harbour notes.\n\nNow with a new paragraph.';
    memory.tables.nango_sync_records[0].last_synced_at = OLD;
    expect(await sync(CONN_A)).toMatchObject({ processed: 1, failed: 0 });

    const rows = await documentRows(db);
    expect(rows.map((row) => [row.version, row.is_current, row.status])).toEqual([
      [1, false, 'ready'],
      [2, true, 'ready'],
    ]);
    expect(rows[1].lineage_id).toBe(rows[0].lineage_id);
    expect(recordsOf(userA)[0]).toMatchObject({ document_id: rows[1].id, status: 'completed' });
  });

  it.each([
    { syncing: CONN_A, owner: userA, other: userB, otherConn: CONN_B },
    { syncing: CONN_B, owner: userB, other: userA, otherConn: CONN_A },
  ])('a sync of $syncing writes and deletes only in its owner tenant, even when the other owner has the same provider file id', async ({ syncing, owner, other, otherConn }) => {
    for (const conn of [CONN_A, CONN_B]) {
      setFiles(conn, [textFile(SHARED_FILE_ID, OLD), textFile(`${conn}-only`, OLD)], {
        [SHARED_FILE_ID]: `Shared name, content of ${conn}.\n\nOnly this owner has these words.`,
        [`${conn}-only`]: `Private file of ${conn}.\n\nKept apart.`,
      });
    }
    await sync(CONN_A);
    await sync(CONN_B);

    const ownerKey = `u:${owner}`;
    const otherKey = `u:${other}`;
    const before = await snapshot(otherKey);
    expect(before.documents).toHaveLength(2);
    expect(new Set((await documentRows(db)).map((row) => row.tenant_key))).toEqual(new Set([ownerKey, otherKey]));
    expect(before.documents.every((row) => row.user_id === other && row.source_connection_id === otherConn)).toBe(true);

    // Both files vanish at the owner's source; the other owner's copy of the shared file id stays at theirs.
    remote.drive[syncing][FOLDER] = [];
    ingestSpy.mockClear();
    expect(await sync(syncing)).toMatchObject({ processed: 0, deleted: 2 });

    expect(await snapshot(ownerKey)).toEqual({ documents: [], chunkIds: [], records: [] });
    expect(await snapshot(otherKey)).toEqual(before);
    expect(recordsOf(other).map((row) => row.file_id).sort()).toEqual([SHARED_FILE_ID, `${otherConn}-only`].sort());
  });

  it('every ingest call of a sync carries the scope of the connection owner', async () => {
    setFiles(CONN_A, [textFile('a1'), textFile('a2')], { a1: 'Alpha one.\n\nMore alpha.', a2: 'Alpha two.\n\nStill alpha.' });
    setFiles(CONN_B, [textFile('b1')], { b1: 'Bravo one.\n\nMore bravo.' });

    await sync(CONN_A);
    expect(scopesOfIngestCalls()).toEqual([`u:${userA}`, `u:${userA}`]);

    ingestSpy.mockClear();
    await sync(CONN_B);
    expect(scopesOfIngestCalls()).toEqual([`u:${userB}`]);
  });

  it('a file whose provider says the same name as another tenant\'s document never reaches that tenant', async () => {
    setFiles(CONN_A, [textFile(SHARED_FILE_ID)], { [SHARED_FILE_ID]: 'Owner A text.\n\nParagraph.' });
    setFiles(CONN_B, [textFile(SHARED_FILE_ID)], { [SHARED_FILE_ID]: 'Owner B text.\n\nParagraph.' });

    await sync(CONN_A);
    await sync(CONN_B);

    const rows = await documentRows(db);
    expect(rows.map((row) => [row.tenant_key, row.source_key, row.version, row.is_current]).sort()).toEqual(
      [
        [`u:${userA}`, SHARED_FILE_ID, 1, true],
        [`u:${userB}`, SHARED_FILE_ID, 1, true],
      ].sort(),
    );
    expect(new Set(rows.map((row) => row.lineage_id)).size).toBe(2);
  });

  it('an orphan delete removes every version of the file lineage, but never a document of another source or another file', async () => {
    setFiles(CONN_A, [textFile('keep', OLD), textFile('drop', OLD)], {
      keep: 'Keep this one.\n\nIt stays.',
      drop: 'Drop this one, first edition.\n\nIt goes.',
    });
    await sync(CONN_A);
    remote.contents[`${CONN_A}/drop`] = 'Drop this one, second edition.\n\nIt goes too.';
    remote.drive[CONN_A][FOLDER] = [textFile('keep', OLD), textFile('drop', MODIFIED)];
    await sync(CONN_A);
    // A chat upload of the same tenant, and a Nango file of the same tenant held by another connection, must survive.
    await db.exec(
      `INSERT INTO documents (id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata, user_id)
       VALUES ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000f1', 1, true, 'ready', 'chat_upload', 'root/drop.txt', 'drop.txt', 'upload', '{}', '${userA}'),
              ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000f2', 1, true, 'ready', 'nango', 'drop-elsewhere', 'drop.txt', 'other connection', '{}', '${userA}')`,
    );
    // A document of the other owner that claims this connection and file id (a corrupt or forged row) must survive too: the tenant decides, not the claim.
    await db.exec(
      `INSERT INTO documents (id, lineage_id, version, is_current, status, source, source_key, filename, content, metadata, user_id)
       VALUES ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000f3', 1, true, 'ready', 'nango', 'drop-claimed', 'drop.txt', 'claims conn a', '{}', '${userB}')`,
    );
    await db.exec(`UPDATE documents SET source_file_id = 'drop', source_connection_id = 'conn-elsewhere' WHERE id = '00000000-0000-4000-8000-0000000000f2'`);
    await db.exec(`UPDATE documents SET source_file_id = 'drop', source_connection_id = '${CONN_A}' WHERE id = '00000000-0000-4000-8000-0000000000f3'`);
    expect((await documentRows(db)).filter((row) => row.source_key === 'drop' && row.source_connection_id === CONN_A)).toHaveLength(2);

    remote.drive[CONN_A][FOLDER] = [textFile('keep', OLD)];
    expect(await sync(CONN_A)).toMatchObject({ deleted: 1 });

    const { rows } = await db.query<{ id: string; source: string; source_key: string }>(`SELECT id, source, source_key FROM documents ORDER BY id`);
    const remaining = rows.filter((row) => row.source === 'nango' || row.source === 'chat_upload').map((row) => `${row.source}:${row.source_key}`);
    expect(remaining).toContain('chat_upload:root/drop.txt');
    expect(remaining).toContain('nango:keep');
    expect(rows.some((row) => row.id === '00000000-0000-4000-8000-0000000000f2')).toBe(true);
    expect(rows.some((row) => row.id === '00000000-0000-4000-8000-0000000000f3')).toBe(true);
    expect((await documentRows(db)).filter((row) => row.source_key === 'drop' && row.source_connection_id === CONN_A)).toEqual([]);
    expect(recordsOf(userA).map((row) => row.file_id)).toEqual(['keep']);
  });

  it('a folder default and a connection default from rag_doc_type_defaults type the synced file in the D-15 order', async () => {
    const keyA = `u:${userA}`;
    await db.query(`SELECT * FROM rag_set_doc_type_default($1, 'nango', $2, 'contract_legal', 'admin')`, [keyA, 'folder-contracts']);
    await db.query(`SELECT * FROM rag_set_doc_type_default($1, 'nango', $2, 'financial_report', 'admin')`, [keyA, CONN_A]);
    setFiles('conn-defaults', [textFile('agreement')], { agreement: 'This agreement is made between two parties.\n\n1. Term. The term is one year.' }, 'folder-contracts');
    setFiles(CONN_A, [textFile('ledger')], { ledger: 'Quarterly ledger.\n\nRevenue grew.' });
    setFiles(CONN_B, [textFile('plain')], { plain: 'Plain notes of owner B.\n\nNothing special.' });

    await sync('conn-defaults');
    await sync(CONN_A);
    await sync(CONN_B);

    const byKey = new Map((await documentRows(db)).map((row) => [row.source_key, row]));
    expect(byKey.get('agreement')).toMatchObject({ doc_type: 'contract_legal', doc_type_origin: 'source_default' });
    expect(byKey.get('ledger')).toMatchObject({ doc_type: 'financial_report', doc_type_origin: 'source_default' });
    // Owner A's defaults do not apply to owner B's tenant.
    expect(byKey.get('plain')?.doc_type_origin).not.toBe('source_default');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Webhook: the signature check stays, and the owner never comes from the payload.
// ---------------------------------------------------------------------------------------------------------------------

describe('nango webhook', () => {
  const syncDocumentsForConnection = vi.fn(async () => ({ processed: 0, failed: 0, skipped: 0, deleted: 0 }));
  const SECRET = 'placeholder-webhook-secret';

  async function post(body: string, signature: string | null, secret: string | null = SECRET) {
    vi.resetModules();
    if (secret === null) vi.stubEnv('NANGO_WEBHOOK_SECRET', '');
    else vi.stubEnv('NANGO_WEBHOOK_SECRET', secret);
    const actual = await vi.importActual<typeof import('@/lib/nango/client')>('@/lib/nango/client');
    vi.doMock('@/lib/nango/client', () => ({ ...actual, isNangoEnabled: () => true }));
    vi.doMock('@/lib/nango/sync-manager', () => ({ syncDocumentsForConnection }));
    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => createMemoryDb().admin }));
    const { POST } = await import('@/app/api/nango/webhook/route');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== null) headers['x-nango-signature'] = signature;
    const { NextRequest } = await import('next/server');
    return POST(new NextRequest('http://localhost/api/nango/webhook', { method: 'POST', headers, body }));
  }

  async function sign(body: string, secret = SECRET): Promise<string> {
    const { createHmac } = await import('node:crypto');
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  const body = JSON.stringify({
    type: 'sync.success',
    connectionId: CONNECTION,
    providerConfigKey: 'google-drive',
    userId: OWNER_B,
    user_id: OWNER_B,
    end_user: { id: OWNER_B },
  });

  beforeEach(() => {
    syncDocumentsForConnection.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const id of ['@/lib/nango/client', '@/lib/nango/sync-manager', '@/lib/supabase']) vi.doUnmock(id);
  });

  it('refuses a request without a signature, with a wrong one and with a short one, and syncs nothing', async () => {
    for (const signature of [null, '', 'deadbeef', await sign(body, 'another-secret')]) {
      const response = await post(body, signature);
      expect(response.status).toBe(401);
    }
    expect(syncDocumentsForConnection).not.toHaveBeenCalled();
  });

  it('fails closed when no webhook secret is configured, even for a signature computed with an empty secret', async () => {
    const response = await post(body, await sign(body, ''), null);

    expect(response.status).toBe(401);
    expect(syncDocumentsForConnection).not.toHaveBeenCalled();
  });

  it('a signed event syncs the connection by id and provider only; no owner from the payload reaches the sync', async () => {
    const response = await post(body, await sign(body));

    expect(response.status).toBe(200);
    expect(syncDocumentsForConnection).toHaveBeenCalledTimes(1);
    expect(syncDocumentsForConnection.mock.calls[0]).toEqual([CONNECTION, 'google-drive']);
  });
});
