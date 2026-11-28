import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

/**
 * D-48 (owner decision 2026-11-25, DATA-23): the in-sync orphan removal of every provider path removes nothing from a
 * listing that did not complete, in every deletion mode, and records one incomplete sync run.
 */

const state = vi.hoisted(() => ({ memory: null as null | { admin: unknown } }));

type ProxyRequest = { providerConfigKey: string; endpoint: string; data?: Record<string, unknown> };

const remote = vi.hoisted(() => ({
  dropbox: {} as Record<string, { entries: Record<string, unknown>[]; has_more?: boolean } | 'fail'>,
  records: { records: [] as Record<string, unknown>[], next_cursor: null as string | null } as
    | { records: Record<string, unknown>[]; next_cursor: string | null }
    | 'fail',
}));

const proxy = vi.hoisted(() =>
  vi.fn(async (request: ProxyRequest) => {
    if (request.providerConfigKey === 'dropbox') {
      const page = remote.dropbox[String(request.data?.path ?? '')] ?? { entries: [] };
      if (page === 'fail') throw new Error('proxy down');
      return { data: page };
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
const softDeleteLineage = vi.hoisted(() =>
  vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true as const, outcome: 'deleted' as const, lineageId, jobId: null })),
);
const purgeLineage = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));

vi.mock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.memory?.admin ?? null }));
vi.mock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('neutral text')) }));
vi.mock('@/lib/nango/source-alerts', () => ({ raiseSourceAlert: vi.fn(async () => 'connection_status' as const) }));
vi.mock('@/lib/nango/permission-sync', () => ({
  notionWorkspaceId: vi.fn(async () => null),
  syncSourcePermissions: vi.fn(async () => ({ outcome: 'skipped' })),
}));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => 'unified', processDocumentWithMetadata: vi.fn(async () => null) }));
vi.mock('@/lib/rag', async () => {
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  return {
    isPurgeTombstoned: async () => ({ ok: true, tombstoned: false }),
    recomputeDirtyDupClusters: async () => ({ ok: true }),
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage,
    purgeLineage,
    removeDocumentObjects: vi.fn(async () => undefined),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
  };
});

import { syncDocumentsForConnection } from '@/lib/nango/sync-manager';

const OWNER: string = TWO_TENANT_IDS.userA;
const TENANT = `u:${OWNER}`;
const CONNECTION_ID = 'conn-guard-listing';
const ROW_ID = '00000000-0000-4000-8000-00000000e281';
const FILES = ['f1', 'f2', 'f3'];
const SKIP_LINE = 'Orphan deletion skipped: listing incomplete';

type Mode = null | 'soft' | 'purge';

const dropboxFile = (id: string): Row => ({ '.tag': 'file', id, name: `${id}.txt`, path_display: `/${id}.txt`, client_modified: '2026-01-02T03:04:05Z' });

function seed(provider: string, mode: Mode, extra: Row = {}) {
  const memory = createNangoMemoryAdmin({
    nango_connections: [
      { id: ROW_ID, connection_id: CONNECTION_ID, user_id: OWNER, provider, deletion_mode: mode, status: 'connected', sync_folder_id: null, sync_file_ids: null, ...extra },
    ],
    nango_sync_records: FILES.map((fileId) => ({
      id: `rec-${fileId}`,
      user_id: OWNER,
      connection_id: CONNECTION_ID,
      file_id: fileId,
      file_name: `${fileId}.txt`,
      document_id: `doc-${fileId}`,
      status: 'completed',
    })),
    documents: FILES.map((fileId) => ({
      id: `doc-${fileId}`,
      lineage_id: `lin-${fileId}`,
      tenant_key: TENANT,
      source: 'nango',
      source_connection_id: CONNECTION_ID,
      source_key: fileId,
      is_current: true,
    })),
  });
  state.memory = memory;
  return memory;
}

const recordIds = (memory: ReturnType<typeof createNangoMemoryAdmin>) =>
  (memory.tables.nango_sync_records ?? []).map((record) => String(record.file_id)).sort();
const runs = (memory: ReturnType<typeof createNangoMemoryAdmin>) =>
  memory.rpcs.filter((call) => call.name === 'rag_source_reconcile_run_record').map((call) => [call.args.p_origin, call.args.p_status]);
const skipLines = () => vi.mocked(console.error).mock.calls.filter((call) => String(call[0]).includes(SKIP_LINE));

describe('in-sync orphan removal needs a complete listing in every mode (D-48)', () => {
  beforeEach(() => {
    remote.dropbox = {};
    remote.records = { records: [], next_cursor: null };
    softDeleteLineage.mockClear();
    purgeLineage.mockClear();
    for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  it.each([null, 'soft', 'purge'] as Mode[])('a cut Dropbox listing (has_more) removes nothing in mode %s', async (mode) => {
    const memory = seed('dropbox', mode);
    remote.dropbox[''] = { entries: [dropboxFile('f1'), dropboxFile('f2')], has_more: true };
    const stats = await syncDocumentsForConnection(CONNECTION_ID, 'dropbox');
    expect(stats.deleted).toBe(0);
    expect(recordIds(memory)).toEqual(FILES);
    expect(memory.tables.documents).toHaveLength(3);
    expect(softDeleteLineage).not.toHaveBeenCalled();
    expect(purgeLineage).not.toHaveBeenCalled();
    expect(runs(memory)).toEqual([['sync', 'incomplete']]);
    const lines = skipLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({ connectionId: CONNECTION_ID, provider: 'dropbox' });
  });

  it.each([null, 'soft', 'purge'] as Mode[])('a complete Dropbox listing lacking one of three removes it in mode %s', async (mode) => {
    const memory = seed('dropbox', mode);
    remote.dropbox[''] = { entries: [dropboxFile('f1'), dropboxFile('f2')] };
    const stats = await syncDocumentsForConnection(CONNECTION_ID, 'dropbox');
    expect(stats.deleted).toBe(1);
    expect(recordIds(memory)).toEqual(['f1', 'f2']);
    expect(runs(memory)).toEqual([['sync', 'completed']]);
    expect(skipLines()).toHaveLength(0);
    if (mode === 'soft') expect(softDeleteLineage.mock.calls.map((call) => call[1])).toEqual(['lin-f3']);
    if (mode === 'purge') expect(purgeLineage).toHaveBeenCalledTimes(1);
  });

  it.each(['box', 'confluence'])('a %s records call that throws removes nothing', async (provider) => {
    const memory = seed(provider, null);
    remote.records = 'fail';
    const stats = await syncDocumentsForConnection(CONNECTION_ID, provider);
    expect(stats.deleted).toBe(0);
    expect(recordIds(memory)).toEqual(FILES);
    expect(runs(memory)).toEqual([['sync', 'incomplete']]);
  });

  it('a records page set with a next cursor removes nothing', async () => {
    const memory = seed('box', null);
    remote.records = { records: [{ id: 'f1', name: 'f1.txt' }], next_cursor: 'cursor-2' };
    const stats = await syncDocumentsForConnection(CONNECTION_ID, 'box');
    expect(stats.deleted).toBe(0);
    expect(recordIds(memory)).toEqual(FILES);
  });

  it('a multi-folder listing with one failing folder removes nothing in the default mode', async () => {
    const memory = seed('dropbox', null, { sync_folder_id: 'multi-folder-mode', sync_file_ids: ['/a', '/b'] });
    remote.dropbox['/a'] = { entries: [dropboxFile('f1')] };
    remote.dropbox['/b'] = 'fail';
    const stats = await syncDocumentsForConnection(CONNECTION_ID, 'dropbox');
    expect(stats.deleted).toBe(0);
    expect(recordIds(memory)).toEqual(FILES);
    expect(runs(memory)).toEqual([['sync', 'incomplete']]);
  });
});
