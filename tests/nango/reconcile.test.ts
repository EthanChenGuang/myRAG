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
    isPurgeTombstoned: async () => ({ ok: true, tombstoned: false }),
    recomputeDirtyDupClusters: async () => ({ ok: true }),
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage: vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true, outcome: 'deleted', lineageId, jobId: null })),
    removeDocumentObjects: vi.fn(async () => undefined),
    recomputeDirtyDupClusters: vi.fn(async () => ({ ok: true, skipped: true })),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
    retryPendingPurgeObjects: async () => ({ ok: true, records: 0, cleared: 0, stillPending: 0 }),
    rescrubRecentPurges: async () => ({ ok: true, records: 0, scrubbed: 0 }),
  };
});

import { connectionReconcileState, runSourceReconcile, type ReconcileConnectionRow } from '@/lib/nango/reconcile';

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

describe('failures, the age alert and the first run (D-09, D-10, D-39)', () => {
  let now: number;

  beforeEach(() => {
    state.pipeline = 'unified';
    now = Date.now();
    for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  const run = (memory: ReturnType<typeof createDb>, connectors: Record<string, FakeConnector>, extra: { deadlineMs?: number; now?: () => number } = {}) =>
    runSourceReconcile({ deadlineMs: extra.deadlineMs ?? 50_000, now: extra.now ?? (() => now), deps: { admin: memory.admin as never, listFiles: listerFor(connectors) } });

  it('a listing that keeps failing records failed runs, removes nothing and raises one overdue alert per run once over the age', async () => {
    const row = connection(10, { connected_at: new Date(now - 10 * DAY).toISOString() });
    const memory = createDb({ nango_connections: [row], nango_sync_records: records('conn-10', ['file-a', 'file-b']), documents: documents('conn-10', ['file-a', 'file-b']) });
    const connector = createFakeConnector({ files: [] });
    connector.failListing();

    const first = await run(memory, { 'conn-10': connector });
    const second = await run(memory, { 'conn-10': connector });

    expect(first).toMatchObject({ processed: 1, failed: 1, removed: 0, overdue: 1 });
    expect(second).toMatchObject({ processed: 1, failed: 1, removed: 0, overdue: 1 });
    expect(runsOf(memory, row.id)).toEqual([['scheduled', 'failed'], ['scheduled', 'failed']]);
    expect(memory.tables.documents).toHaveLength(2);
    expect((memory.tables.nango_connections ?? [])[0]!.last_reconcile_status).toBe('overdue');
  });

  it('a failing listing within the age limit marks the connection failed and raises no alert', async () => {
    const row = connection(11, { connected_at: new Date(now - 2 * DAY).toISOString() });
    const memory = createDb({ nango_connections: [row], nango_sync_records: records('conn-11', ['file-a']), documents: documents('conn-11', ['file-a']) });
    const connector = createFakeConnector({ files: [] });
    connector.failListing();

    const result = await run(memory, { 'conn-11': connector });

    expect(result).toMatchObject({ failed: 1, overdue: 0, removed: 0 });
    expect((memory.tables.nango_connections ?? [])[0]!.last_reconcile_status).toBe('failed');
    expect(memory.tables.documents).toHaveLength(1);
  });

  it('first run: a connection connected 30 days ago is reconciled before its age is evaluated and is not alerted', async () => {
    const row = connection(12, { connected_at: new Date(now - 30 * DAY).toISOString() });
    const memory = createDb({ nango_connections: [row], nango_sync_records: records('conn-12', ['file-a', 'file-b']), documents: documents('conn-12', ['file-a', 'file-b']) });

    const result = await run(memory, { 'conn-12': createFakeConnector({ files: ['file-a', 'file-b'] }) });

    expect(result).toMatchObject({ processed: 1, overdue: 0 });
    expect(runsOf(memory, row.id)).toEqual([['scheduled', 'completed']]);
    expect((memory.tables.nango_connections ?? [])[0]!.last_reconcile_status).toBe('ok');
  });

  it('first run: the same connection is alerted when its first scheduled attempt does not complete', async () => {
    const row = connection(13, { connected_at: new Date(now - 30 * DAY).toISOString() });
    const memory = createDb({ nango_connections: [row], nango_sync_records: records('conn-13', ['file-a', 'file-b']), documents: documents('conn-13', ['file-a', 'file-b']) });
    const connector = createFakeConnector({ files: ['file-a'] });
    connector.cutListing(1);

    const result = await run(memory, { 'conn-13': connector });

    expect(result).toMatchObject({ processed: 1, incomplete: 1, removed: 0, overdue: 1 });
    expect(runsOf(memory, row.id)).toEqual([['scheduled', 'incomplete']]);
    expect(memory.tables.documents).toHaveLength(2);
  });

  it('a complete listing that would remove 70 % of 20 documents pauses and removes nothing', async () => {
    const files = Array.from({ length: 20 }, (_, index) => `file-${index + 1}`);
    const row = connection(14);
    const memory = createDb({ nango_connections: [row], nango_sync_records: records('conn-14', files), documents: documents('conn-14', files) });

    const result = await run(memory, { 'conn-14': createFakeConnector({ files: files.slice(0, 6) }) });

    expect(result).toMatchObject({ processed: 1, paused: 1, removed: 0 });
    expect(runsOf(memory, row.id)).toEqual([['scheduled', 'awaiting_confirmation']]);
    expect(memory.tables.documents).toHaveLength(20);
    expect((memory.tables.nango_connections ?? [])[0]!.last_reconcile_status).toBe('paused');
  });

  it('respects the deadline: no further connection is started once it has passed', async () => {
    const memory = createDb({ nango_connections: [connection(15), connection(16)] });
    const connectors = { 'conn-15': createFakeConnector({ files: [] }), 'conn-16': createFakeConnector({ files: [] }) };
    // Clock reads: the start, the two purge follow-ups (D-15, C-10), the first connection.
    const ticks = [now, now, now, now];
    const clock = () => ticks.shift() ?? now + 1;

    const result = await run(memory, connectors, { deadlineMs: 1, now: clock });

    expect(result).toMatchObject({ processed: 1, skipped: 1 });
    expect(connectors['conn-15'].listings + connectors['conn-16'].listings).toBe(1);
  });
});

describe('connectionReconcileState (D-10, D-39)', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const limits = { maxAgeDays: 7 };
  const daysAgo = (days: number) => new Date(now - days * DAY).toISOString();

  it('a paused overdue connection shows paused first, then overdue', () => {
    const row = connection(20, { connected_at: daysAgo(40), last_full_reconcile_at: daysAgo(12) });
    const run = { origin: 'scheduled', status: 'awaiting_confirmation', expires_at: new Date(now + DAY).toISOString() };
    expect(connectionReconcileState(row, run, true, now, limits)).toEqual({ states: ['paused', 'overdue'], daysWithoutReconcile: 12, reason: null });
  });

  it('is not_run before the first scheduled attempt, however old the connection is', () => {
    const row = connection(21, { connected_at: daysAgo(30) });
    expect(connectionReconcileState(row, null, false, now, limits)).toEqual({ states: ['not_run'], daysWithoutReconcile: 30, reason: null });
  });

  it('is in_step after a recent completed run', () => {
    const row = connection(22, { connected_at: daysAgo(30), last_full_reconcile_at: daysAgo(1) });
    const run = { origin: 'scheduled', status: 'completed', created_at: daysAgo(1) };
    expect(connectionReconcileState(row, run, true, now, limits)).toEqual({ states: ['in_step'], daysWithoutReconcile: 1, reason: null });
  });

  it('reports incomplete and failed with their reasons', () => {
    const row = connection(23, { connected_at: daysAgo(30), last_full_reconcile_at: daysAgo(2) });
    expect(connectionReconcileState(row, { origin: 'scheduled', status: 'incomplete' }, true, now, limits)).toEqual({
      states: ['incomplete'],
      daysWithoutReconcile: 2,
      reason: 'listing_incomplete',
    });
    expect(connectionReconcileState(row, { origin: 'scheduled', status: 'failed', error_code: 'listing_failed' }, true, now, limits)).toEqual({
      states: ['failed'],
      daysWithoutReconcile: 2,
      reason: 'listing_failed',
    });
  });

  it('an expired paused run no longer counts as paused', () => {
    const row = connection(24, { connected_at: daysAgo(30), last_full_reconcile_at: daysAgo(1) });
    const run = { origin: 'scheduled', status: 'awaiting_confirmation', expires_at: new Date(now - 1).toISOString() };
    expect(connectionReconcileState(row, run, true, now, limits).states).toEqual(['in_step']);
  });
});
