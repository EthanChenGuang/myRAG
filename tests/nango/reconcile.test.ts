import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';
import { createFakeConnector, type FakeConnector } from '../helpers/fake-connector';

const state = vi.hoisted(() => ({ pipeline: 'unified' as 'legacy' | 'unified' }));

vi.mock('@/lib/nango/client', () => ({ getNango: () => ({ proxy: vi.fn(), listRecords: vi.fn() }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => null }));
vi.mock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('neutral text')) }));
vi.mock('@/lib/nango/permission-sync', () => ({
  notionWorkspaceId: vi.fn(async () => null),
  syncSourcePermissions: vi.fn(async () => ({ outcome: 'skipped' })),
}));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => state.pipeline, processDocumentWithMetadata: vi.fn(async () => 'doc-new') }));
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
  };
});

import { runSourceReconcile, type ReconcileConnectionRow } from '@/lib/nango/reconcile';

const OWNER: string = TWO_TENANT_IDS.userA;
const TENANT = `u:${OWNER}`;
const DAY = 86_400_000;

const rowId = (n: number) => `00000000-0000-4000-8000-0000000f${String(n).padStart(4, '0')}`;

function connection(n: number, extra: Partial<ReconcileConnectionRow> = {}): ReconcileConnectionRow & Row {
  return {
    id: rowId(n),
    connection_id: `conn-${n}`,
    user_id: OWNER,
    provider: 'google-drive',
    deletion_mode: null,
    status: 'connected',
    connected_at: null,
    last_full_reconcile_at: null,
    last_reconcile_status: null,
    sync_folder_id: 'folder-root',
    sync_file_ids: null,
    ...extra,
  };
}

function records(connectionId: string, fileIds: string[]): Row[] {
  return fileIds.map((fileId) => ({
    id: `rec-${connectionId}-${fileId}`,
    user_id: OWNER,
    connection_id: connectionId,
    file_id: fileId,
    file_name: `${fileId}.txt`,
    document_id: `doc-${connectionId}-${fileId}`,
    status: 'completed',
  }));
}

function documents(connectionId: string, fileIds: string[]): Row[] {
  return fileIds.map((fileId) => ({
    id: `doc-${connectionId}-${fileId}`,
    lineage_id: `lin-${connectionId}-${fileId}`,
    tenant_key: TENANT,
    source: 'nango',
    source_connection_id: connectionId,
    source_key: fileId,
    user_id: OWNER,
  }));
}

/** A memory database whose run writer follows 0721: it records the run and moves the connection's reconcile fields. */
function createDb(seed: Record<string, Row[]>) {
  const holder: { memory: ReturnType<typeof createNangoMemoryAdmin> | null } = { memory: null };
  let counter = 0;
  const memory = createNangoMemoryAdmin(
    { rag_source_reconcile_runs: [], ...seed },
    {
      rpc: (name, args) => {
        if (name !== 'rag_source_reconcile_run_record') return { data: null, error: { code: '42883', message: 'unknown' } };
        const tables = holder.memory!.tables;
        counter += 1;
        const runId = `run-${counter}`;
        const counts = (args.p_counts ?? {}) as Row;
        (tables.rag_source_reconcile_runs ??= []).push({
          id: runId,
          connection_id: args.p_connection_id,
          tenant_key: args.p_tenant_key,
          origin: args.p_origin,
          status: args.p_status,
          error_code: counts.error_code ?? null,
          candidate_count: counts.candidates ?? 0,
          created_at: new Date().toISOString(),
        });
        const target = (tables.nango_connections ?? []).find((entry) => entry.id === args.p_connection_id);
        if (target) {
          if (args.p_status === 'completed' && (args.p_origin === 'sync' || args.p_origin === 'scheduled')) {
            target.last_full_reconcile_at = new Date().toISOString();
            target.last_reconcile_status = 'ok';
          } else if (args.p_status === 'incomplete' || args.p_status === 'failed') {
            target.last_reconcile_status = args.p_status;
          } else if (args.p_status === 'awaiting_confirmation') {
            target.last_reconcile_status = 'paused';
          }
        }
        return { data: [{ run_id: runId, expires_at: null }], error: null };
      },
    },
  );
  holder.memory = memory;
  return memory;
}

function listerFor(connectors: Record<string, FakeConnector>) {
  return async (row: ReconcileConnectionRow) => {
    const connector = connectors[row.connection_id];
    if (!connector) throw new Error('no connector');
    return connector.list();
  };
}

const runsOf = (memory: ReturnType<typeof createNangoMemoryAdmin>, id: string) =>
  (memory.tables.rag_source_reconcile_runs ?? []).filter((run) => run.connection_id === id).map((run) => [run.origin, run.status]);

describe('runSourceReconcile (D-06, D-07, D-31)', () => {
  let now: number;

  beforeEach(() => {
    state.pipeline = 'unified';
    now = Date.now();
    for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  it('removes the document of a file that vanished from a complete listing and advances the reconcile time', async () => {
    const row = connection(1, { connected_at: new Date(now - 3 * DAY).toISOString() });
    const memory = createDb({
      nango_connections: [row],
      nango_sync_records: records('conn-1', ['file-a', 'file-b', 'file-c']),
      documents: documents('conn-1', ['file-a', 'file-b', 'file-c']),
    });
    const connector = createFakeConnector({ files: ['file-a', 'file-b'] });

    const result = await runSourceReconcile({ deadlineMs: 50_000, now: () => now, deps: { admin: memory.admin as never, listFiles: listerFor({ 'conn-1': connector }) } });

    expect(result).toMatchObject({ processed: 1, removed: 1, incomplete: 0, paused: 0 });
    expect((memory.tables.documents ?? []).map((doc) => doc.source_key).sort()).toEqual(['file-a', 'file-b']);
    expect((memory.tables.nango_sync_records ?? []).map((record) => record.file_id).sort()).toEqual(['file-a', 'file-b']);
    expect(runsOf(memory, row.id)).toEqual([['scheduled', 'completed']]);
    const stored = (memory.tables.nango_connections ?? [])[0]!;
    expect(typeof stored.last_full_reconcile_at).toBe('string');
    expect(Math.abs(Date.parse(String(stored.last_full_reconcile_at)) - Date.now())).toBeLessThan(5_000);
  });

  it('does not process a connection reconciled within the interval', async () => {
    const row = connection(2, { last_full_reconcile_at: new Date(now - 2 * DAY).toISOString(), last_reconcile_status: 'ok' });
    const memory = createDb({ nango_connections: [row], nango_sync_records: records('conn-2', ['file-a']), documents: documents('conn-2', ['file-a']) });
    const connector = createFakeConnector({ files: [] });

    const result = await runSourceReconcile({ deadlineMs: 50_000, now: () => now, deps: { admin: memory.admin as never, listFiles: listerFor({ 'conn-2': connector }) } });

    expect(result.processed).toBe(0);
    expect(connector.listings).toBe(0);
    expect(memory.tables.documents).toHaveLength(1);
  });

  it('limits the run to the given connection even when others are due', async () => {
    const first = connection(3);
    const second = connection(4);
    const memory = createDb({
      nango_connections: [first, second],
      nango_sync_records: [...records('conn-3', ['file-a', 'file-b']), ...records('conn-4', ['file-a', 'file-b'])],
      documents: [...documents('conn-3', ['file-a', 'file-b']), ...documents('conn-4', ['file-a', 'file-b'])],
    });
    const connectors = { 'conn-3': createFakeConnector({ files: ['file-a'] }), 'conn-4': createFakeConnector({ files: ['file-a'] }) };

    const result = await runSourceReconcile({
      deadlineMs: 50_000,
      connectionId: second.id,
      now: () => now,
      deps: { admin: memory.admin as never, listFiles: listerFor(connectors) },
    });

    expect(result).toMatchObject({ processed: 1, removed: 1 });
    expect(connectors['conn-3'].listings).toBe(0);
    expect(connectors['conn-4'].listings).toBe(1);
    expect(runsOf(memory, first.id)).toEqual([]);
    expect(runsOf(memory, second.id)).toEqual([['scheduled', 'completed']]);
  });
});
