import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

const state = vi.hoisted(() => ({
  memory: null as null | { admin: unknown },
  pipeline: 'unified' as 'legacy' | 'unified',
}));

type ProxyRequest = { providerConfigKey: string; endpoint: string; data?: Record<string, unknown>; params?: Record<string, string> };

const remote = vi.hoisted(() => ({
  dropbox: {} as Record<string, { entries: Row[]; has_more?: boolean } | 'fail'>,
  notion: null as null | { results: Row[]; has_more?: boolean } | 'fail',
  records: { records: [] as Row[], next_cursor: null as string | null } as { records: Row[]; next_cursor: string | null } | 'fail',
}));

const proxy = vi.hoisted(() =>
  vi.fn(async (request: ProxyRequest) => {
    if (request.providerConfigKey === 'dropbox') {
      const folder = String(request.data?.path ?? '');
      const page = remote.dropbox[folder] ?? { entries: [] };
      if (page === 'fail') throw new Error('proxy down');
      return { data: page };
    }
    if (request.providerConfigKey === 'notion') {
      if (request.endpoint === '/v1/search') {
        if (remote.notion === 'fail') throw new Error('proxy down');
        return { data: remote.notion ?? { results: [] } };
      }
      return { data: { results: [] } };
    }
    throw new Error(`unexpected proxy ${request.providerConfigKey}`);
  }),
);
const listRecords = vi.hoisted(() =>
  vi.fn(async () => {
    if (remote.records === 'fail') throw new Error('records down');
    return remote.records;
  }),
);
const processDocumentWithMetadata = vi.hoisted(() => vi.fn(async () => 'doc-new'));

vi.mock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.memory?.admin ?? null }));
vi.mock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('neutral text')) }));
vi.mock('@/lib/nango/permission-sync', () => ({
  notionWorkspaceId: vi.fn(async () => null),
  syncSourcePermissions: vi.fn(async () => ({ outcome: 'skipped' })),
}));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => state.pipeline, processDocumentWithMetadata }));
vi.mock('@/lib/rag', async () => {
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  return {
    isPurgeTombstoned: async () => ({ ok: true, tombstoned: false }),
    recomputeDirtyDupClusters: async () => ({ ok: true }),
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage: vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true, outcome: 'deleted', lineageId, jobId: null })),
    removeDocumentObjects: vi.fn(async () => undefined),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
  };
});

import { listConnectionFiles, removeOrphans, syncDocumentsForConnection } from '@/lib/nango/sync-manager';

const OWNER: string = TWO_TENANT_IDS.userA;
const TENANT = `u:${OWNER}`;
const CONNECTION_ID = 'conn-listing';
const ROW_ID = '00000000-0000-4000-8000-00000000e001';

function row(provider: string, extra: Row = {}) {
  return { id: ROW_ID, connection_id: CONNECTION_ID, user_id: OWNER, provider, deletion_mode: null, sync_folder_id: null, sync_file_ids: null, ...extra };
}

const dropboxFile = (id: string, extra: Row = {}): Row => ({ '.tag': 'file', id, name: `${id}.txt`, path_display: `/${id}.txt`, client_modified: '2026-01-02T03:04:05Z', ...extra });

describe('listing completeness and the reconcile exports (D-07, D-31)', () => {
  beforeEach(() => {
    state.pipeline = 'unified';
    state.memory = createNangoMemoryAdmin({});
    remote.dropbox = {};
    remote.notion = null;
    remote.records = { records: [], next_cursor: null };
    processDocumentWithMetadata.mockClear();
    for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  it('a complete Dropbox listing returns its file ids and complete true', async () => {
    remote.dropbox[''] = { entries: [dropboxFile('f1'), dropboxFile('f2'), { '.tag': 'folder', id: 'dir', name: 'dir' }] };
    expect(await listConnectionFiles(row('dropbox'))).toEqual({ fileIds: ['f1', 'f2'], complete: true });
  });

  it('Dropbox with has_more reports complete false', async () => {
    remote.dropbox[''] = { entries: [dropboxFile('f1')], has_more: true };
    expect((await listConnectionFiles(row('dropbox'))).complete).toBe(false);
  });

  it('the records fallback with a next cursor reports complete false', async () => {
    remote.records = { records: [{ id: 'r1', name: 'r1.txt' }], next_cursor: 'cursor-2' };
    expect(await listConnectionFiles(row('box'))).toEqual({ fileIds: ['r1'], complete: false });
    remote.records = 'fail';
    expect(await listConnectionFiles(row('box'))).toEqual({ fileIds: [], complete: false });
    remote.records = { records: [{ id: 'r1', name: 'r1.txt' }], next_cursor: null };
    expect(await listConnectionFiles(row('box'))).toEqual({ fileIds: ['r1'], complete: true });
  });

  it('a Notion listing that errored reports complete false', async () => {
    remote.notion = 'fail';
    expect(await listConnectionFiles(row('notion'))).toEqual({ fileIds: [], complete: false });
    remote.notion = { results: [{ id: 'p1', last_edited_time: '2026-01-01T00:00:00Z' }] };
    expect(await listConnectionFiles(row('notion'))).toEqual({ fileIds: ['p1'], complete: true });
  });

  it('a non-Drive multi-folder listing with one failing folder reports complete false', async () => {
    remote.dropbox['/a'] = { entries: [dropboxFile('f1')] };
    remote.dropbox['/b'] = 'fail';
    const listing = await listConnectionFiles(row('dropbox', { sync_folder_id: 'multi-folder-mode', sync_file_ids: ['/a', '/b'] }));
    expect(listing).toEqual({ fileIds: ['f1'], complete: false });
  });

  it('listing a connection ingests nothing', async () => {
    remote.dropbox[''] = { entries: [dropboxFile('f1')] };
    await listConnectionFiles(row('dropbox'));
    expect(processDocumentWithMetadata).not.toHaveBeenCalled();
  });

  it('removeOrphans runs the guarded removal for the scheduled reconcile', async () => {
    const records = ['f1', 'f2', 'f3'].map((fileId) => ({
      id: `rec-${fileId}`,
      user_id: OWNER,
      connection_id: CONNECTION_ID,
      file_id: fileId,
      file_name: `${fileId}.txt`,
      document_id: null,
      status: 'completed',
    }));
    const memory = createNangoMemoryAdmin({ nango_sync_records: records });
    state.memory = memory;
    const removed = await removeOrphans(row('dropbox'), ['f1', 'f2'], 'scheduled');
    expect(removed).toBe(1);
    expect((memory.tables.nango_sync_records ?? []).map((record) => record.file_id).sort()).toEqual(['f1', 'f2']);
    expect(memory.rpcs.map((call) => [call.args.p_origin, call.args.p_status])).toEqual([['scheduled', 'completed']]);
  });

  it('removeOrphans removes nothing from an incomplete listing', async () => {
    const memory = createNangoMemoryAdmin({
      nango_sync_records: [{ id: 'rec-f1', user_id: OWNER, connection_id: CONNECTION_ID, file_id: 'f1', file_name: 'f1.txt', document_id: null, status: 'completed' }],
    });
    state.memory = memory;
    expect(await removeOrphans(row('dropbox'), [], 'scheduled', { complete: false })).toBe(0);
    expect(memory.tables.nango_sync_records).toHaveLength(1);
    expect(memory.rpcs.map((call) => call.args.p_status)).toEqual(['incomplete']);
  });

  it('a sync stamps source_last_seen_at and source_modified_at on the current documents of a listed, unchanged file', async () => {
    remote.dropbox[''] = { entries: [dropboxFile('f1', { rev: 'rev-1' }), dropboxFile('f2')] };
    const memory = createNangoMemoryAdmin({
      nango_connections: [{ ...row('dropbox'), status: 'connected' }],
      nango_sync_records: [
        {
          id: 'rec-f1',
          user_id: OWNER,
          connection_id: CONNECTION_ID,
          file_id: 'f1',
          file_name: 'f1.txt',
          document_id: 'doc-f1',
          status: 'completed',
          last_synced_at: '2026-06-01T00:00:00Z',
        },
      ],
      documents: [
        { id: 'doc-f1', tenant_key: TENANT, source: 'nango', source_connection_id: CONNECTION_ID, source_key: 'f1', is_current: true },
        { id: 'doc-f1-old', tenant_key: TENANT, source: 'nango', source_connection_id: CONNECTION_ID, source_key: 'f1', is_current: false },
      ],
    });
    state.memory = memory;
    processDocumentWithMetadata.mockImplementationOnce(async () => 'doc-f2');
    await syncDocumentsForConnection(CONNECTION_ID, 'dropbox');

    const stamps = memory.ops.filter((op) => op.table === 'documents' && op.operation === 'update');
    expect(stamps.map((op) => op.filters.find((filter) => filter.column === 'source_key')?.value)).toEqual(['f1', 'f2']);
    for (const op of stamps) {
      expect(op.filters).toEqual(
        expect.arrayContaining([
          { kind: 'eq', column: 'tenant_key', value: TENANT },
          { kind: 'eq', column: 'source', value: 'nango' },
          { kind: 'eq', column: 'source_connection_id', value: CONNECTION_ID },
          { kind: 'eq', column: 'is_current', value: true },
        ]),
      );
    }
    const current = memory.tables.documents?.find((doc) => doc.id === 'doc-f1');
    expect(typeof current?.source_last_seen_at).toBe('string');
    expect(current?.source_modified_at).toBe('2026-01-02T03:04:05.000Z');
    expect(current?.source_etag).toBe('rev-1');
    expect(memory.tables.documents?.find((doc) => doc.id === 'doc-f1-old')?.source_last_seen_at).toBeUndefined();
  });

  it('a listed file with no document writes nothing', async () => {
    remote.dropbox[''] = { entries: [dropboxFile('f9')] };
    const memory = createNangoMemoryAdmin({ nango_connections: [{ ...row('dropbox'), status: 'connected' }] });
    state.memory = memory;
    processDocumentWithMetadata.mockImplementationOnce(async () => {
      throw new Error('ingest failed');
    });
    await syncDocumentsForConnection(CONNECTION_ID, 'dropbox');
    expect(memory.ops.filter((op) => op.table === 'documents')).toEqual([]);
  });
});
