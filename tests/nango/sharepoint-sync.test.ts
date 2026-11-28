import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';
import { startFakeGraph, type FakeGraph } from '../helpers/fake-graph';

const raiseSourceAlert = vi.hoisted(() => vi.fn(async () => 'connection_status' as const));
const processDocumentWithMetadata = vi.hoisted(() => vi.fn(async () => 'doc-new'));
const state = vi.hoisted(() => ({ admin: null as unknown, tombstoned: new Set<string>(), tombstoneFails: false }));

vi.mock('@/lib/nango/source-alerts', () => ({ raiseSourceAlert }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.admin }));
vi.mock('@/lib/nango/client', () => ({
  getNango: () => {
    throw new Error('no Nango call expected');
  },
}));
vi.mock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('neutral text')) }));
vi.mock('@/lib/nango/permission-sync', () => ({
  notionWorkspaceId: vi.fn(async () => null),
  syncSourcePermissions: vi.fn(async () => ({ outcome: 'skipped' })),
}));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => 'unified', processDocumentWithMetadata }));
vi.mock('@/lib/rag', async () => {
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  return {
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage: vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true, outcome: 'deleted', lineageId, jobId: null })),
    removeDocumentObjects: vi.fn(async () => undefined),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
    isPurgeTombstoned: vi.fn(async (_scope: unknown, _connectionId: string, fileId: string) =>
      state.tombstoneFails ? { ok: false, reason: 'unavailable' } : { ok: true, tombstoned: state.tombstoned.has(fileId) },
    ),
  };
});

import { listSharePointFiles, syncSharePointConnection, type SharePointSyncHooks } from '@/lib/nango/sharepoint/sync';
import { syncDocumentsForConnection } from '@/lib/nango/sync-manager';
import type { GraphTransport } from '@/lib/nango/sharepoint/graph';

const OWNER = TWO_TENANT_IDS.userA;
const ROW_ID = '00000000-0000-4000-8000-00000000e012';
const CONNECTION = 'conn-sp';
const DRIVE = 'drive-a';
const START = `/v1.0/drives/${DRIVE}/root/delta`;
const STORED = `${START}?token=delta-0001`;

type Selection = { sites?: Row[]; drives?: Row[]; folders?: Row[] };

const connectionRow = (selection: Selection | null, extra: Row = {}): Row => ({
  id: ROW_ID,
  connection_id: CONNECTION,
  user_id: OWNER,
  provider: 'sharepoint-online',
  deletion_mode: null,
  metadata: selection ? { source_scope: { sites: [], drives: [], folders: [], ...selection }, ...extra } : { ...extra },
});

const record = (fileId: string, metadata: Row = {}, status = 'completed'): Row => ({
  id: `rec-${fileId}`,
  user_id: OWNER,
  connection_id: CONNECTION,
  provider: 'sharepoint-online',
  file_id: fileId,
  file_name: `${fileId}.txt`,
  document_id: `doc-${fileId}`,
  status,
  metadata: { drive_id: DRIVE, ...metadata },
});

const token = (deltaLink: string | null, nextLink: string | null = null): Row => ({
  connection_id: ROW_ID,
  feed: 'graph_delta',
  feed_key: DRIVE,
  delta_link: deltaLink,
  next_link: nextLink,
});

const item = (id: string, parent: string, etag: string, extra: Row = {}): Row => ({
  id,
  name: `${id}.txt`,
  eTag: `"{00000000-0000-0000-0000-0000000000${etag}},1"`,
  lastModifiedDateTime: '2026-03-01T00:00:00Z',
  file: { mimeType: 'text/plain' },
  parentReference: { driveId: DRIVE, id: parent, siteId: 'site-a' },
  ...extra,
});

const deltaBody = (value: Row[], deltaToken = 'delta-0002') => ({
  status: 200,
  body: { '@odata.deltaLink': `https://graph.microsoft.com${START}?token=${deltaToken}`, value },
});

function hooks(): SharePointSyncHooks & { seen: Row[] } {
  const seen: Row[] = [];
  return {
    seen,
    markSourceSeen: vi.fn(async (_admin, input) => {
      seen.push(input as Row);
    }),
    isSupportedFile: (name: string) => /\.(txt|pdf|docx|md)$/i.test(name),
    ownerOnlyLabel: (userId: string) => [`u:${userId.toLowerCase()}`],
    processDocument: processDocumentWithMetadata as unknown as SharePointSyncHooks['processDocument'],
    fetchContent: vi.fn(async () => Buffer.from('neutral text')),
  };
}

let graph: FakeGraph | undefined;

beforeEach(() => {
  raiseSourceAlert.mockClear();
  processDocumentWithMetadata.mockClear();
  processDocumentWithMetadata.mockImplementation(async () => 'doc-new');
  for (const method of ['warn', 'error', 'log', 'debug', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(async () => {
  const running = graph;
  graph = undefined;
  await running?.close();
  delete process.env.NEXT_PUBLIC_NANGO_SHAREPOINT_ENABLED;
  state.admin = null;
  state.tombstoned = new Set();
  state.tombstoneFails = false;
});

const syncRecordIds = (memory: ReturnType<typeof createNangoMemoryAdmin>) =>
  memory.tables.nango_sync_records.map((row) => row.file_id as string).sort();
const storedToken = (memory: ReturnType<typeof createNangoMemoryAdmin>) => memory.tables.rag_source_delta_tokens?.[0] ?? null;

describe('SharePoint delta apply (D-21, D-22, D-40)', () => {
  it('ingests a new file, re-ingests a changed one, removes a deleted one through change_feed and commits the link after apply', async () => {
    graph = await startFakeGraph();
    graph.respondOnce(
      STORED,
      deltaBody([item('item-new', 'item-root', 'a1'), item('item-changed', 'item-root', 'b2'), { id: 'item-gone', deleted: { state: 'deleted' }, file: {}, parentReference: { driveId: DRIVE } }]),
    );
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [connectionRow({ drives: [{ id: DRIVE, name: 'Library A' }] })],
        nango_sync_records: [record('item-changed', { etag: '"{00000000-0000-0000-0000-0000000000b1},1"' }), record('item-gone')],
        rag_source_delta_tokens: [token(STORED)],
      },
      { storeWrites: true },
    );
    const h = hooks();
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, h, { transport: graph.transport() });

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.deleted).toBe(1);
    const calls = processDocumentWithMetadata.mock.calls as unknown as Array<[string, Buffer, Row]>;
    expect(calls.map((call) => call[2].sourceFileId).sort()).toEqual(['item-changed', 'item-new']);
    for (const call of calls) {
      expect(call[2]).toMatchObject({ userId: OWNER, source: 'nango', sourceProvider: 'sharepoint-online', sourceConnectionId: CONNECTION, accessKeys: [`u:${OWNER.toLowerCase()}`] });
    }
    expect(h.seen.map((input) => [input.fileId, input.etag, input.modifiedAt])).toEqual([
      ['item-new', '"{00000000-0000-0000-0000-0000000000a1},1"', '2026-03-01T00:00:00Z'],
      ['item-changed', '"{00000000-0000-0000-0000-0000000000b2},1"', '2026-03-01T00:00:00Z'],
    ]);
    expect(memory.rpcs.filter((call) => call.args.p_origin === 'change_feed').map((call) => call.args.p_candidate_file_ids)).toEqual([['item-gone']]);
    expect(syncRecordIds(memory)).toEqual(['item-changed', 'item-new']);
    const newRecord = memory.tables.nango_sync_records.find((row) => row.file_id === 'item-new')!;
    expect(newRecord.status).toBe('completed');
    expect(newRecord.metadata).toMatchObject({ drive_id: DRIVE, etag: '"{00000000-0000-0000-0000-0000000000a1},1"' });
    expect(storedToken(memory)).toMatchObject({ delta_link: `${START}?token=delta-0002`, next_link: null });
    expect(result.committedDrives).toEqual([DRIVE]);
  });

  it('skips an admin-purged item (D-35): no sync record, no download, no ingest, counted withdrawn, link committed', async () => {
    graph = await startFakeGraph();
    graph.respondOnce(STORED, deltaBody([item('item-purged', 'item-root', 'c1'), item('item-new', 'item-root', 'a1')]));
    state.tombstoned.add('item-purged');
    const memory = createNangoMemoryAdmin(
      { nango_connections: [connectionRow({ drives: [{ id: DRIVE, name: 'Library A' }] })], rag_source_delta_tokens: [token(STORED)] },
      { storeWrites: true },
    );
    const h = hooks();
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, h, { transport: graph.transport() });
    expect(result.processed).toBe(1);
    expect(result.withdrawn).toBe(1);
    const calls = processDocumentWithMetadata.mock.calls as unknown as Array<[string, Buffer, Row]>;
    expect(calls.map((call) => call[2].sourceFileId)).toEqual(['item-new']);
    expect((h.fetchContent as unknown as { mock: { calls: Array<[string, string, Row]> } }).mock.calls.map((call) => call[2].id)).toEqual(['item-new']);
    expect(syncRecordIds(memory)).toEqual(['item-new']);
    expect(result.committedDrives).toEqual([DRIVE]);
  });

  it('a failed tombstone lookup skips the item and leaves the link uncommitted (fail closed)', async () => {
    graph = await startFakeGraph();
    graph.respondOnce(STORED, deltaBody([item('item-new', 'item-root', 'a1')]));
    state.tombstoneFails = true;
    const memory = createNangoMemoryAdmin(
      { nango_connections: [connectionRow({ drives: [{ id: DRIVE, name: 'Library A' }] })], rag_source_delta_tokens: [token(STORED)] },
      { storeWrites: true },
    );
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    expect(processDocumentWithMetadata).not.toHaveBeenCalled();
    expect(syncRecordIds(memory)).toEqual([]);
    expect(result.committedDrives).toEqual([]);
    expect(storedToken(memory)).toMatchObject({ delta_link: STORED });
  });

  it('commits no link when a removal fails', async () => {
    graph = await startFakeGraph();
    graph.respondOnce(STORED, deltaBody([{ id: 'item-gone', deleted: { state: 'deleted' }, file: {}, parentReference: { driveId: DRIVE } }]));
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [connectionRow({ drives: [{ id: DRIVE, name: 'Library A' }] })],
        nango_sync_records: [record('item-gone')],
        rag_source_delta_tokens: [token(STORED)],
      },
      { storeWrites: true, failDelete: { table: 'nango_sync_records', error: { code: 'XX000', message: 'boom' } } },
    );
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    expect(result.committedDrives).toEqual([]);
    expect(storedToken(memory)).toMatchObject({ delta_link: STORED, next_link: null });
  });

  it('commits no link when an ingest fails', async () => {
    graph = await startFakeGraph();
    graph.respondOnce(STORED, deltaBody([item('item-new', 'item-root', 'a1')]));
    processDocumentWithMetadata.mockImplementationOnce(async () => {
      throw new Error('ingest down');
    });
    const memory = createNangoMemoryAdmin(
      { nango_connections: [connectionRow({ drives: [{ id: DRIVE, name: 'Library A' }] })], rag_source_delta_tokens: [token(STORED)] },
      { storeWrites: true },
    );
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    expect(result.failed).toBe(1);
    expect(storedToken(memory)).toMatchObject({ delta_link: STORED });
    expect(memory.tables.nango_sync_records[0]).toMatchObject({ file_id: 'item-new', status: 'failed' });
  });

  it('ignores an item outside the selection, keeps the drive id on the record and skips an unchanged eTag before download', async () => {
    graph = await startFakeGraph();
    graph.respondOnce(
      STORED,
      deltaBody([
        { id: 'item-folder-1', name: 'Folder 1', folder: {}, parentReference: { driveId: DRIVE, id: 'item-root' } },
        { id: 'item-folder-2', name: 'Folder 2', folder: {}, parentReference: { driveId: DRIVE, id: 'item-root' } },
        item('item-in', 'item-folder-1', 'a1'),
        item('item-out', 'item-folder-2', 'a2'),
        item('item-same', 'item-folder-1', 'a3'),
      ]),
    );
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] }, { source_parents: { [DRIVE]: { 'item-root': null } } })],
        nango_sync_records: [record('item-same', { etag: '"{00000000-0000-0000-0000-0000000000a3},1"' })],
        rag_source_delta_tokens: [token(STORED)],
      },
      { storeWrites: true },
    );
    const h = hooks();
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, h, { transport: graph.transport() });
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(h.fetchContent).toHaveBeenCalledTimes(1);
    expect((h.fetchContent as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ id: 'item-in', drive_id: DRIVE });
    expect(syncRecordIds(memory)).toEqual(['item-in', 'item-same']);
    expect(memory.tables.nango_sync_records.find((row) => row.file_id === 'item-in')!.metadata).toMatchObject({ drive_id: DRIVE, site_id: 'site-a', parent_id: 'item-folder-1' });
    const parents = (memory.tables.nango_connections[0].metadata as Row).source_parents as Record<string, Row>;
    expect(parents[DRIVE]).toMatchObject({ 'item-folder-1': 'item-root', 'item-folder-2': 'item-root' });
  });

  it('uses the stored folder parent map to place a new file in a nested folder', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [
          connectionRow(
            { folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] },
            { source_parents: { [DRIVE]: { 'item-root': null, 'item-folder-1': 'item-root', 'item-folder-1a': 'item-folder-1' } } },
          ),
        ],
        rag_source_delta_tokens: [token(`${START}?token=scope-delta-1`)],
      },
      { storeWrites: true },
    );
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    expect(result.processed).toBe(1);
    expect(syncRecordIds(memory)).toEqual(['item-file-n2']);
  });

  it('with the switch off, syncDocumentsForConnection returns zero stats without a Graph or database call', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    const memory = createNangoMemoryAdmin({ nango_connections: [connectionRow({ drives: [{ id: DRIVE, name: 'Library A' }] })] }, { storeWrites: true });
    state.admin = memory.admin;
    for (const provider of ['sharepoint-online', 'one-drive']) {
      await expect(syncDocumentsForConnection(CONNECTION, provider)).resolves.toEqual({ processed: 0, failed: 0, skipped: 0, deleted: 0, failClosed: 0 });
    }
    expect(graph.calls).toEqual([]);
    expect(memory.ops).toEqual([]);
  });
});

describe('SharePoint full enumeration as a full listing (D-09, D-21, D-22, D-31)', () => {
  it('full listing: a completed token-less enumeration removes synced files absent from it or out of scope, and records one completed run', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] })],
        nango_sync_records: [record('item-file-a'), record('item-old-1'), record('item-old-2')],
      },
      { storeWrites: true },
    );
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    expect(result.paused).toBe(false);
    expect(syncRecordIds(memory)).toEqual(['item-file-a', 'item-file-n']);
    const runs = memory.rpcs.filter((call) => call.args.p_origin === 'sync');
    expect(runs.map((call) => call.args.p_status)).toEqual(['completed']);
    expect(runs[0].args.p_counts).toMatchObject({ total: 3, candidates: 2 });
    expect(storedToken(memory)).toMatchObject({ delta_link: `${START}?token=scope-delta-1`, next_link: null });
  });

  it('full listing that would remove 8 of 10 synced files pauses: nothing removed, an alert, the link not committed', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    const old = Array.from({ length: 8 }, (_, index) => record(`item-old-${index + 1}`));
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] })],
        nango_sync_records: [record('item-file-a'), record('item-file-n'), ...old],
      },
      { storeWrites: true },
    );
    const result = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    expect(result.paused).toBe(true);
    expect(memory.tables.nango_sync_records).toHaveLength(10);
    expect(memory.rpcs.map((call) => call.args.p_status)).toEqual(['awaiting_confirmation']);
    expect(raiseSourceAlert).toHaveBeenCalledTimes(1);
    expect(storedToken(memory)).toBeNull();
    expect(result.committedDrives).toEqual([]);
  });

  it('full listing after the selection drops a folder: its synced files are removal candidates through the guard', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    const memory = createNangoMemoryAdmin(
      {
        // Folder 2 was selected before; the selection now names Folder 1 only.
        nango_connections: [connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] })],
        nango_sync_records: [record('item-file-a'), record('item-file-n'), record('item-file-x')],
      },
      { storeWrites: true },
    );
    await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport: graph.transport() });
    const guardRun = memory.rpcs.find((call) => call.args.p_origin === 'sync')!;
    expect(guardRun.args.p_status).toBe('completed');
    expect(guardRun.args.p_counts).toMatchObject({ candidates: 1, total: 3 });
    expect(syncRecordIds(memory)).toEqual(['item-file-a', 'item-file-n']);
  });

  it('full listing resumed after a deadline is the union of its reads', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    let clock = 1_000_000;
    const inner = graph.transport();
    let first = true;
    const transport: GraphTransport = async (request) => {
      const response = await inner(request);
      if (first) {
        first = false;
        clock += 60_000;
      }
      return response;
    };
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] })],
        nango_sync_records: [record('item-old-1')],
      },
      { storeWrites: true },
    );
    const firstRun = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport, now: () => clock, deadlineMs: 30_000 });
    expect(firstRun.committedDrives).toEqual([DRIVE]);
    expect(storedToken(memory)?.delta_link ?? null).toBeNull();
    expect(storedToken(memory)).toMatchObject({ next_link: `${START}?token=scope-page-2` });
    expect(memory.rpcs.filter((call) => call.args.p_origin === 'sync')).toEqual([]);
    expect(syncRecordIds(memory)).toEqual(['item-file-a', 'item-old-1']);
    const enumeration = (memory.tables.nango_connections[0].metadata as Row).source_enumeration as Record<string, Row>;
    expect(enumeration[DRIVE]).toMatchObject({ present: ['item-file-a'] });

    const secondRun = await syncSharePointConnection(CONNECTION, memory.admin as never, hooks(), { transport, now: () => clock, deadlineMs: 30_000 });
    expect(secondRun.paused).toBe(false);
    // item-file-a was only in the first read: the union keeps it.
    expect(syncRecordIds(memory)).toEqual(['item-file-a', 'item-file-n']);
    expect(storedToken(memory)).toMatchObject({ delta_link: `${START}?token=scope-delta-1`, next_link: null });
    expect(((memory.tables.nango_connections[0].metadata as Row).source_enumeration as Row)[DRIVE]).toBeUndefined();
  });

  it('listSharePointFiles enumerates the selected drives without reading or writing the stored link', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    const memory = createNangoMemoryAdmin({ rag_source_delta_tokens: [token(`${START}?token=scope-delta-1`)] }, { storeWrites: true });
    const row = connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] });
    const listing = await listSharePointFiles(row as never, memory.admin as never, { transport: graph.transport() });
    expect(listing.complete).toBe(true);
    expect(listing.fileIds.sort()).toEqual(['item-file-a', 'item-file-n']);
    expect(graph.calls.map((call) => call.pathAndQuery)).toEqual([START, `${START}?token=scope-page-2`]);
    expect(memory.ops.filter((op) => op.table === 'rag_source_delta_tokens')).toEqual([]);
  });

  it('listSharePointFiles reports complete false when the deadline cuts it', async () => {
    graph = await startFakeGraph('drive-delta-scope');
    let clock = 0;
    const inner = graph.transport();
    const transport: GraphTransport = async (request) => {
      const response = await inner(request);
      clock += 60_000;
      return response;
    };
    const row = connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] });
    const listing = await listSharePointFiles(row as never, null, { transport, now: () => clock, deadlineMs: 30_000 });
    expect(listing.complete).toBe(false);
    expect(listing.fileIds).toEqual(['item-file-a']);
  });

  it('with the switch off, listConnectionFiles reports an incomplete empty listing for SharePoint without a Graph call', async () => {
    const { listConnectionFiles } = await import('@/lib/nango/sync-manager');
    const row = connectionRow({ folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: DRIVE }] });
    await expect(listConnectionFiles(row as never)).resolves.toEqual({ fileIds: [], complete: false });
  });
});
