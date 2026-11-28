import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';

const softDeleteLineage = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, outcome: 'deleted' as const, lineageId: 'line-a', jobId: null })),
);

vi.mock('@/lib/rag/ingest/soft-delete', () => ({ softDeleteLineage }));

const OWNER_A = TWO_TENANT_IDS.userA;
const OWNER_B = TWO_TENANT_IDS.userB;
const CONNECTION = 'conn-soft-delete';
const FOLDER = 'folder-soft';
const TENANT_A = `u:${OWNER_A}`;

type Row = Record<string, unknown>;

const state = {
  pipeline: 'unified' as 'legacy' | 'unified',
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  ingestAsync: false,
};

const remote = { drive: {} as Record<string, Record<string, Row[]>> };

const proxy = vi.fn(async (request: { connectionId: string; params?: Record<string, string> }) => {
  const folder = /'([^']+)' in parents/.exec(request.params?.q ?? '')?.[1] ?? '';
  return { data: { files: remote.drive[request.connectionId]?.[folder] ?? [] } };
});

function connection(connectionId: string, userId: string): Row {
  return {
    id: `row-${connectionId}`,
    connection_id: connectionId,
    user_id: userId,
    provider: 'google-drive',
    sync_folder_id: FOLDER,
  };
}

function createMemoryDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {
    nango_connections: [],
    nango_sync_records: [],
    documents: [],
    document_chunks: [],
    ...seed,
  };
  const ops: Array<{ table: string; op: string; filters: unknown[] }> = [];

  function from(table: string) {
    let op = 'select' as 'select' | 'delete';
    const filters: unknown[] = [];
    const builder = {
      select() {
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
      single() {
        const rows = tables[table] ?? [];
        const matched = rows.filter((row) =>
          filters.every((filter) => {
            const entry = filter as { kind: string; column: string; value: unknown };
            if (entry.kind === 'eq') return row[entry.column] === entry.value;
            if (entry.kind === 'in') return (entry.value as unknown[]).includes(row[entry.column]);
            return true;
          }),
        );
        return Promise.resolve({ data: matched[0] ?? null, error: matched[0] ? null : { message: 'not found' } });
      },
      then: (onFulfilled: (value: { data: Row[]; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) => {
        const rows = tables[table] ?? [];
        if (op === 'delete') {
          const matched = rows.filter((row) =>
            filters.every((filter) => {
              const entry = filter as { kind: string; column: string; value: unknown };
              if (entry.kind === 'eq') return row[entry.column] === entry.value;
              if (entry.kind === 'in') return (entry.value as unknown[]).includes(row[entry.column]);
              return true;
            }),
          );
          tables[table] = rows.filter((row) => !matched.includes(row));
          ops.push({ table, op, filters });
          return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected);
        }
        const matched = rows.filter((row) =>
          filters.every((filter) => {
            const entry = filter as { kind: string; column: string; value: unknown };
            if (entry.kind === 'eq') return row[entry.column] === entry.value;
            if (entry.kind === 'in') return (entry.value as unknown[]).includes(row[entry.column]);
            return true;
          }),
        );
        return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return {
    tables,
    ops,
    admin: { from },
    documentIds: () => tables.documents.map((row) => row.id),
  };
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
  vi.doMock('@/lib/nango/document-adapter', () => ({
    processDocumentWithMetadata: vi.fn(),
    nangoPipeline: () => state.pipeline,
  }));
  vi.doMock('@/lib/rag/ingest/queue-config', () => ({
    queueConfigFromProcessEnv: () => ({ ingestAsync: state.ingestAsync }),
    resetQueueConfigForTests: () => {},
  }));
  vi.doMock('@/lib/rag', () => ({
    ingest: vi.fn(),
    buildSourceKey: identity.buildSourceKey,
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: state.mode }),
    currentIngestConfig: () => ({ pipeline: state.pipeline }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage,
    removeDocumentObjects: async () => ({ removed: 0, failed: 0 }),
    queueConfigFromProcessEnv: () => ({ ingestAsync: state.ingestAsync }),
  }));

  return import('@/lib/nango/sync-manager');
}

describe('deleteOrphanedDocuments soft delete under the queue (D-27)', () => {
  beforeEach(() => {
    softDeleteLineage.mockClear();
    remote.drive = { [CONNECTION]: { [FOLDER]: [] } };
    state.pipeline = 'unified';
    state.ingestAsync = false;
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

  const orphanSeed = () =>
    createMemoryDb({
      nango_connections: [connection(CONNECTION, OWNER_A)],
      nango_sync_records: [
        { id: 'rec-a', user_id: OWNER_A, connection_id: CONNECTION, file_id: 'gone', file_name: 'gone.pdf', document_id: 'doc-a', status: 'completed' },
        { id: 'rec-b', user_id: OWNER_B, connection_id: 'conn-b', file_id: 'gone', file_name: 'gone.pdf', document_id: 'doc-b', status: 'completed' },
      ],
      documents: [
        {
          id: 'doc-a',
          lineage_id: 'line-a',
          tenant_key: TENANT_A,
          user_id: OWNER_A,
          source: 'nango',
          source_connection_id: CONNECTION,
          source_file_id: 'gone',
          source_key: 'gone',
        },
        {
          id: 'doc-b',
          lineage_id: 'line-b',
          tenant_key: `u:${OWNER_B}`,
          user_id: OWNER_B,
          source: 'nango',
          source_file_id: 'gone',
          source_key: 'gone',
        },
      ],
    });

  it('with unified and async on, an orphan is soft-deleted in the owner tenant only', async () => {
    state.ingestAsync = true;
    const memory = orphanSeed();
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(1);
    expect(softDeleteLineage).toHaveBeenCalledTimes(1);
    const call = softDeleteLineage.mock.calls[0] as unknown as [Record<string, unknown>, string, string];
    const [scope, lineageId, source] = call;
    expect(scope).toMatchObject({ kind: 'personal', userId: OWNER_A });
    expect(lineageId).toBe('line-a');
    expect(source).toBe('nango');
    expect(memory.documentIds().sort()).toEqual(['doc-a', 'doc-b']);
    expect(memory.ops.some((entry) => entry.table === 'documents' && entry.op === 'delete')).toBe(false);
  });

  it('with unified and async off, orphans are hard-deleted and softDeleteLineage is never called', async () => {
    const memory = orphanSeed();
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(1);
    expect(softDeleteLineage).not.toHaveBeenCalled();
    expect(memory.documentIds()).toEqual(['doc-b']);
    expect(memory.ops.some((entry) => entry.table === 'documents' && entry.op === 'delete')).toBe(true);
  });

  it('with the legacy pipeline, orphans use the hard delete path', async () => {
    state.pipeline = 'legacy';
    const memory = createMemoryDb({
      nango_connections: [connection(CONNECTION, OWNER_A)],
      nango_sync_records: [
        { id: 'rec-a', user_id: OWNER_A, connection_id: CONNECTION, file_id: 'gone', file_name: 'gone.pdf', document_id: 'doc-a', status: 'completed' },
      ],
      documents: [{ id: 'doc-a', user_id: OWNER_A, source: 'nango', source_file_id: 'gone' }],
    });
    const { syncDocumentsForConnection } = await loadSyncManager(memory);

    const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

    expect(stats.deleted).toBe(1);
    expect(softDeleteLineage).not.toHaveBeenCalled();
    expect(memory.documentIds()).toEqual([]);
  });
});