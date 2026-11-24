import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { createPgliteAdmin } from '../../helpers/pglite-admin';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';
import type { EnqueueResult, IngestInput, IngestResult } from '@/lib/rag';

const OWNER_A = '00000000-0000-4000-8000-0000000000a1';
const FILE_ID = 'drive-file-1';
const CONNECTION = 'conn-a';
const FOLDER = 'folder-1';

const state = {
  pipeline: 'unified' as 'legacy' | 'unified',
  asyncOn: false,
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  configThrows: false,
  ingestResults: [] as IngestResult[],
};

const processDocument = vi.fn();
const ingest = vi.fn();
const submitIngest = vi.fn();

function ingestResult(partial: Partial<IngestResult> & Pick<IngestResult, 'status'>): IngestResult {
  return { documentId: null, version: null, parserUsed: 'text', chunkCount: 0, warnings: [], ...partial };
}

function enqueueResult(partial: Partial<EnqueueResult> & Pick<EnqueueResult, 'status'>): EnqueueResult {
  return { jobId: null, documentId: null, ...partial };
}

async function loadAdapter() {
  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  vi.doMock('@/lib/document-processor', () => ({ processDocument }));
  vi.stubEnv('RAG_INGEST_PIPELINE', state.pipeline);
  vi.stubEnv('RAG_INGEST_ASYNC', state.asyncOn ? 'on' : 'off');
  vi.doMock('@/lib/rag', () => ({
    ingest,
    submitIngest,
    buildSourceKey: identity.buildSourceKey,
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: state.mode }),
    currentIngestConfig: () => {
      if (state.configThrows) throw new Error('config unavailable');
      return { pipeline: state.pipeline };
    },
  }));
  return import('@/lib/nango/document-adapter');
}

function ingestInput(call = 0): IngestInput {
  return ingest.mock.calls[call][0] as IngestInput;
}

function submitInput(call = 0): IngestInput {
  return submitIngest.mock.calls[call][0] as IngestInput;
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

beforeEach(() => {
  state.pipeline = 'unified';
  state.asyncOn = false;
  state.mode = 'multi-tenant';
  state.configThrows = false;
  processDocument.mockReset();
  ingest.mockReset();
  submitIngest.mockReset();
  state.ingestResults = [];
  ingest.mockImplementation(
    async () => state.ingestResults.shift() ?? ingestResult({ status: 'ready', documentId: 'doc-default', version: 1 }),
  );
  submitIngest.mockImplementation(
    async () => enqueueResult({ status: 'queued', jobId: 'job-default', documentId: 'doc-queued' }),
  );
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

describe('nango document adapter, unified async switch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('with async on, enqueues through submitIngest with source nango and provider file id as source_key', async () => {
    state.asyncOn = true;
    submitIngest.mockResolvedValue(enqueueResult({ status: 'queued', jobId: 'job-1', documentId: 'doc-v1' }));
    const { processDocumentWithMetadata } = await loadAdapter();
    const buffer = Buffer.from('%PDF-1.4 body');

    const id = await processDocumentWithMetadata('Report.pdf', buffer, baseOptions);

    expect(id).toBe('doc-v1');
    expect(submitIngest).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
    expect(submitInput()).toMatchObject({
      source: 'nango',
      sourceKey: FILE_ID,
      filename: 'Report.pdf',
      mimeType: 'application/pdf',
    });
    expect(submitInput().file).toBe(buffer);
    expect(processDocument).not.toHaveBeenCalled();
  });

  it('with async off, calls ingest and never submitIngest', async () => {
    state.asyncOn = false;
    ingest.mockResolvedValue(ingestResult({ status: 'ready', documentId: 'doc-inline', version: 1 }));
    const { processDocumentWithMetadata } = await loadAdapter();

    expect(await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions)).toBe('doc-inline');
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(submitIngest).not.toHaveBeenCalled();
    expect(ingestInput()).toMatchObject({ source: 'nango', sourceKey: FILE_ID });
  });

  it('with async on, skipped_duplicate returns the existing document id', async () => {
    state.asyncOn = true;
    submitIngest.mockResolvedValue(enqueueResult({ status: 'skipped_duplicate', jobId: 'job-dup', documentId: 'doc-current' }));
    const { processDocumentWithMetadata } = await loadAdapter();

    expect(await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions)).toBe('doc-current');
  });

  it('with async on, a failed enqueue becomes a typed ingest error', async () => {
    state.asyncOn = true;
    submitIngest.mockResolvedValue(enqueueResult({ status: 'failed', documentId: null, reason: 'enqueue_failed' }));
    const { processDocumentWithMetadata, NangoIngestError } = await loadAdapter();

    const failure = await processDocumentWithMetadata('Report.pdf', Buffer.from('x'), baseOptions).catch((error) => error);
    expect(failure).toBeInstanceOf(NangoIngestError);
    expect(failure.reason).toBe('enqueue_failed');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Queued Nango sync with real submitIngest, two owners, and nango_sync_records.
// ---------------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in' | 'is'; column: string; value: unknown };
interface LoggedOp {
  table: string;
  op: 'select' | 'upsert' | 'update' | 'delete';
  filters: Array<[string, unknown]>;
}

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

  return { tables, ops, failSelect, admin: { from } };
}

type MemoryDb = ReturnType<typeof createMemoryDb>;

const { userA, userB } = TWO_TENANT_IDS;
const CONN_A = 'conn-owner-a';
const CONN_B = 'conn-owner-b';
const SHARED_FILE_ID = 'shared-provider-file-id';
const OLD = '2000-01-01T00:00:00.000Z';
const MODIFIED = '2099-01-01T00:00:00.000Z';

const remote = {
  drive: {} as Record<string, Record<string, Row[]>>,
  contents: {} as Record<string, string>,
};

const proxy = vi.fn(async (request: { connectionId: string; params?: Record<string, string> }) => {
  const folder = /'([^']+)' in parents/.exec(request.params?.q ?? '')?.[1] ?? '';
  return { data: { files: remote.drive[request.connectionId]?.[folder] ?? [] } };
});

const fetchFileContent = vi.fn(async (_provider: string, connectionId: string, file: { id: string }) =>
  Buffer.from(remote.contents[`${connectionId}/${file.id}`] ?? `content of ${file.id}`),
);

function connection(connectionId: string, userId: string, extra: Row = {}): Row {
  return {
    id: `row-${connectionId}`,
    connection_id: connectionId,
    user_id: userId,
    provider: 'google-drive',
    sync_folder_id: FOLDER,
    sync_file_ids: null,
    ...extra,
  };
}

function textFile(id: string, modified = MODIFIED): Row {
  return { id, name: `${id}.txt`, mimeType: 'text/plain', modifiedTime: modified };
}

function setFiles(connectionId: string, files: Row[], contents: Record<string, string>) {
  remote.drive[connectionId] = { [FOLDER]: files };
  for (const [fileId, text] of Object.entries(contents)) remote.contents[`${connectionId}/${fileId}`] = text;
}

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
}

async function documentRows(db: PGlite): Promise<DocumentRow[]> {
  const { rows } = await db.query<DocumentRow>(
    `SELECT d.id, d.lineage_id, d.version, d.is_current, d.status, d.tenant_key, d.user_id, d.source, d.source_key, d.source_file_id
       FROM documents d WHERE d.source = 'nango' ORDER BY d.tenant_key, d.source_key, d.version`,
  );
  return rows;
}

async function jobRows(db: PGlite): Promise<Array<{ id: string; tenant_key: string; source: string; source_key: string; document_id: string; status: string }>> {
  const { rows } = await db.query(`SELECT id, tenant_key, source, source_key, document_id, status FROM ingestion_jobs WHERE source = 'nango' ORDER BY created_at`);
  return rows as Array<{ id: string; tenant_key: string; source: string; source_key: string; document_id: string; status: string }>;
}

function recordsOf(memory: MemoryDb, userId: string): Row[] {
  return memory.tables.nango_sync_records.filter((row) => row.user_id === userId);
}

describe('nango sync enqueue under RAG_INGEST_ASYNC=on', () => {
  let fixture: RouteFixture;
  let db: PGlite;
  let memory: MemoryDb;
  let sync: (connectionId: string) => Promise<{ processed: number; failed: number; skipped: number; deleted: number }>;
  let submitSpy: ReturnType<typeof vi.spyOn>;
  let rag: typeof import('@/lib/rag');

  beforeAll(async () => {
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    fixture = await startRouteFixture({
      deploymentMode: 'multi-tenant',
      twoTenant: true,
      seed: async (database) => {
        db = database;
      },
    });
    process.env.RAG_INGEST_PIPELINE = 'unified';
    process.env.RAG_INGEST_ASYNC = 'on';
  });

  afterAll(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
    vi.stubEnv('RAG_INGEST_ASYNC', 'on');
    process.env.RAG_INGEST_PIPELINE = 'unified';
    process.env.RAG_INGEST_ASYNC = 'on';
    remote.drive = {};
    remote.contents = {};
    proxy.mockClear();
    fetchFileContent.mockClear();
    await db.exec(`DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE source = 'nango');`);
    await db.exec(`DELETE FROM ingestion_jobs WHERE source = 'nango';`);
    await db.exec(`DELETE FROM documents WHERE source = 'nango';`);

    memory = createMemoryDb({
      nango_connections: [
        connection(CONN_A, userA),
        connection(CONN_B, userB),
      ],
    });
    const pglite = createPgliteAdmin(db);
    const real = (await vi.importActual<typeof import('@/lib/supabase')>('@/lib/supabase')).getSupabaseAdmin();
    if (!real) throw new Error('fixture admin client missing');
    const admin = {
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
    const enqueueModule = await import('@/lib/rag/ingest/enqueue');
    submitSpy = vi.spyOn(enqueueModule, 'submitIngest');
    const manager = await import('@/lib/nango/sync-manager');
    sync = (connectionId) => manager.syncDocumentsForConnection(connectionId, 'google-drive');

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
    submitSpy?.mockRestore();
    for (const id of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher']) vi.doUnmock(id);
  });

  function scopesOfSubmitCalls(): string[] {
    return (submitSpy.mock.calls as unknown as Array<[IngestInput]>).map((call) => rag.scopeKey(call[0].scope));
  }

  it('each changed file enqueues one nango job in the owner tenant with the provider file id as source_key', async () => {
    setFiles(CONN_A, [textFile('notes')], { notes: 'Harbour notes for owner A.\n\nSecond paragraph.' });

    const stats = await sync(CONN_A);

    expect(stats).toMatchObject({ processed: 1, failed: 0 });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(scopesOfSubmitCalls()).toEqual([`u:${userA}`]);
    const jobs = await jobRows(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenant_key: `u:${userA}`, source: 'nango', source_key: 'notes', status: 'queued' });
    const docs = await documentRows(db);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ tenant_key: `u:${userA}`, source_key: 'notes', status: 'processing', version: 1, is_current: false });
    expect(recordsOf(memory, userA)[0]).toMatchObject({ file_id: 'notes', document_id: docs[0].id, status: 'completed' });
  });

  it('two owners with the same provider file id each get isolated jobs and rows', async () => {
    setFiles(CONN_A, [textFile(SHARED_FILE_ID)], { [SHARED_FILE_ID]: 'Owner A copy.\n\nParagraph.' });
    setFiles(CONN_B, [textFile(SHARED_FILE_ID)], { [SHARED_FILE_ID]: 'Owner B copy.\n\nParagraph.' });

    await sync(CONN_A);
    await sync(CONN_B);

    const jobs = await jobRows(db);
    expect(jobs.map((row) => [row.tenant_key, row.source_key]).sort()).toEqual(
      [
        [`u:${userA}`, SHARED_FILE_ID],
        [`u:${userB}`, SHARED_FILE_ID],
      ].sort(),
    );
    const docs = await documentRows(db);
    expect(new Set(docs.map((row) => row.tenant_key))).toEqual(new Set([`u:${userA}`, `u:${userB}`]));
    expect(new Set(docs.map((row) => row.lineage_id)).size).toBe(2);
    expect(recordsOf(memory, userA)).toHaveLength(1);
    expect(recordsOf(memory, userB)).toHaveLength(1);
  });

  it('an unchanged file at the provider is skipped without enqueue and owner B rows stay untouched', async () => {
    setFiles(CONN_A, [textFile('notes', OLD)], { notes: 'First edition.\n\nStill first.' });
    setFiles(CONN_B, [textFile('notes', OLD)], { notes: 'Owner B notes.\n\nPrivate.' });
    await sync(CONN_A);
    await sync(CONN_B);
    const bBefore = await documentRows(db).then((rows) => rows.filter((row) => row.tenant_key === `u:${userB}`));
    const jobsBefore = await jobRows(db);

    submitSpy.mockClear();
    expect(await sync(CONN_A)).toMatchObject({ processed: 0, skipped: 1 });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(await jobRows(db)).toEqual(jobsBefore);

    const bAfter = await documentRows(db).then((rows) => rows.filter((row) => row.tenant_key === `u:${userB}`));
    expect(bAfter).toEqual(bBefore);
    expect(recordsOf(memory, userB)).toHaveLength(1);
  });

  it('new bytes for owner A create version two and the sync record names it', async () => {
    setFiles(CONN_A, [textFile('notes', OLD)], { notes: 'Edition one.\n\nParagraph.' });
    await sync(CONN_A);
    const [v1] = await documentRows(db);

    remote.contents[`${CONN_A}/notes`] = 'Edition two.\n\nNew paragraph.';
    memory.tables.nango_sync_records[0].last_synced_at = OLD;
    remote.drive[CONN_A][FOLDER] = [textFile('notes', MODIFIED)];

    submitSpy.mockClear();
    expect(await sync(CONN_A)).toMatchObject({ processed: 1, failed: 0 });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const queued = await submitSpy.mock.results[0].value;
    expect(queued.status).toBe('queued');

    const rows = await documentRows(db);
    expect(rows.map((row) => [row.version, row.is_current, row.status])).toEqual([
      [1, false, 'processing'],
      [2, false, 'processing'],
    ]);
    expect(rows[1].lineage_id).toBe(v1.lineage_id);
    expect(recordsOf(memory, userA)[0]).toMatchObject({ document_id: rows[1].id, status: 'completed' });
    expect((await jobRows(db)).filter((row) => row.status === 'queued')).toHaveLength(2);
  });
});