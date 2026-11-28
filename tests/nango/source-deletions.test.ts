import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

const state = vi.hoisted(() => ({
  pipeline: 'unified' as 'legacy' | 'unified',
  ingestAsync: false,
  softOk: true,
}));

const softDeleteLineage = vi.hoisted(() =>
  vi.fn(async (_scope: unknown, lineageId: string) =>
    state.softOk ? { ok: true as const, outcome: 'deleted' as const, lineageId, jobId: null } : { ok: false as const, reason: 'unavailable' },
  ),
);
const removeDocumentObjects = vi.hoisted(() => vi.fn(async () => undefined));
const recomputeDirtyDupClusters = vi.hoisted(() => vi.fn(async (_scope: unknown, _options?: unknown) => ({ ok: true as const, skipped: false as const })));

vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => state.pipeline, processDocumentWithMetadata: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => null }));
vi.mock('@/lib/rag', async () => {
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  return {
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage,
    removeDocumentObjects,
    recomputeDirtyDupClusters,
    queueConfigFromProcessEnv: () => ({ ingestAsync: state.ingestAsync }),
  };
});

import { applySourceDeletions, loadSourceConnection, type SourceConnectionRow } from '@/lib/nango/source-deletions';
import { raiseSourceAlert } from '@/lib/nango/source-alerts';

const OWNER: string = TWO_TENANT_IDS.userA;
const OTHER: string = TWO_TENANT_IDS.userB;
const CONNECTION = 'conn-unit';
const TENANT = `u:${OWNER}`;

function connection(mode: 'soft' | 'purge' | null, userId = OWNER): SourceConnectionRow {
  return { id: '00000000-0000-4000-8000-00000000d001', connection_id: CONNECTION, user_id: userId, provider: 'google-drive', deletion_mode: mode };
}

function seed(fileIds: string[], extraDocuments: Row[] = []) {
  return createNangoMemoryAdmin({
    nango_connections: [{ ...connection(null), status: 'connected' }],
    nango_sync_records: fileIds.map((fileId) => ({
      id: `rec-${fileId}`,
      user_id: OWNER,
      connection_id: CONNECTION,
      file_id: fileId,
      file_name: `${fileId}.bin`,
      document_id: `doc-${fileId}`,
      status: 'completed',
    })),
    documents: [
      ...fileIds.map((fileId) => ({
        id: `doc-${fileId}`,
        lineage_id: `line-${fileId}`,
        version: 1,
        tenant_key: TENANT,
        user_id: OWNER,
        source: 'nango',
        source_connection_id: CONNECTION,
        source_key: fileId,
        source_file_id: fileId,
        original_path: null,
        processing_state: null,
      })),
      ...extraDocuments,
    ],
  });
}

const records = (memory: ReturnType<typeof seed>) => (memory.tables.nango_sync_records ?? []).map((row) => String(row.file_id)).sort();
const documents = (memory: ReturnType<typeof seed>) => (memory.tables.documents ?? []).map((row) => String(row.id)).sort();

describe('applySourceDeletions (D-03, D-08)', () => {
  beforeEach(() => {
    state.pipeline = 'unified';
    state.ingestAsync = false;
    state.softOk = true;
    softDeleteLineage.mockClear();
    removeDocumentObjects.mockClear();
    recomputeDirtyDupClusters.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('the unset mode under unified/async off deletes every version and the sync record', async () => {
    const memory = seed(['file-a', 'file-b']);
    const result = await applySourceDeletions(connection(null), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 1, failed: 0, deferred: 0 });
    expect(records(memory)).toEqual(['file-b']);
    expect(documents(memory)).toEqual(['doc-file-b']);
    expect(softDeleteLineage).not.toHaveBeenCalled();
    // DATA-21: the hard delete recomputes the dirty duplicate clusters inside the connection owner's tenant only
    expect(recomputeDirtyDupClusters).toHaveBeenCalledTimes(1);
    const [scope] = recomputeDirtyDupClusters.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(JSON.stringify(scope)).toContain(OWNER);
  });

  it('the soft delete leaves the duplicate clusters to the soft-delete path (no recompute here)', async () => {
    state.ingestAsync = true;
    const memory = seed(['file-a']);
    await applySourceDeletions(connection(null), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(recomputeDirtyDupClusters).not.toHaveBeenCalled();
  });

  it('the unset mode under unified/async on soft-deletes, as today', async () => {
    state.ingestAsync = true;
    const memory = seed(['file-a']);
    const result = await applySourceDeletions(connection(null), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(result.removed).toBe(1);
    expect(softDeleteLineage).toHaveBeenCalledTimes(1);
    expect(documents(memory)).toEqual(['doc-file-a']);
  });

  it('a legacy-pipeline change-feed call for a file without a sync record removes nothing', async () => {
    state.pipeline = 'legacy';
    const memory = seed(['file-a']);
    const result = await applySourceDeletions(connection(null), ['file-unknown'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 0, failed: 0, deferred: 0 });
    expect(records(memory)).toEqual(['file-a']);
    expect(documents(memory)).toEqual(['doc-file-a']);
    expect(memory.ops.filter((op) => op.operation === 'delete')).toEqual([]);
  });

  it('soft mode soft-deletes under the legacy pipeline too', async () => {
    state.pipeline = 'legacy';
    const memory = seed(['file-a']);
    const result = await applySourceDeletions(connection('soft'), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(result.removed).toBe(1);
    expect(softDeleteLineage).toHaveBeenCalledTimes(1);
    expect(documents(memory)).toEqual(['doc-file-a']);
    expect(records(memory)).toEqual([]);
  });

  it('a purge connection fails its whole batch and keeps every sync record', async () => {
    const memory = seed(['file-a', 'file-b', 'file-c']);
    const result = await applySourceDeletions(connection('purge'), ['file-a', 'file-b', 'file-c'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 0, failed: 3, deferred: 0 });
    expect(records(memory)).toEqual(['file-a', 'file-b', 'file-c']);
    expect(documents(memory)).toEqual(['doc-file-a', 'doc-file-b', 'doc-file-c']);
  });

  it('a repeated call changes nothing and reports no error', async () => {
    const memory = seed(['file-a']);
    await applySourceDeletions(connection('soft'), ['file-a'], 'change_feed', { admin: memory.admin as never });
    const again = await applySourceDeletions(connection('soft'), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(again).toEqual({ removed: 0, failed: 0, deferred: 0 });
    expect(softDeleteLineage).toHaveBeenCalledTimes(1);
  });

  it('a lineage removal that fails keeps its sync record for the next run', async () => {
    state.softOk = false;
    const memory = seed(['file-a']);
    const result = await applySourceDeletions(connection('soft'), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 0, failed: 1, deferred: 0 });
    expect(records(memory)).toEqual(['file-a']);
  });

  it('the tenant and sync records come from the connection row, not from another user id', async () => {
    const memory = seed(['file-a']);
    expect(await loadSourceConnection(memory.admin as never, CONNECTION, OTHER)).toBeNull();
    const own = await loadSourceConnection(memory.admin as never, CONNECTION, OWNER);
    expect(own?.user_id).toBe(OWNER);

    const forged = await applySourceDeletions(connection('soft', OTHER), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(forged).toEqual({ removed: 0, failed: 0, deferred: 0 });
    expect(records(memory)).toEqual(['file-a']);
    expect(softDeleteLineage).not.toHaveBeenCalled();
  });

  it('a change-feed call records one change_feed run with the handled file ids', async () => {
    const memory = seed(['file-a', 'file-b']);
    await applySourceDeletions(connection('soft'), ['file-a', 'file-b'], 'change_feed', { admin: memory.admin as never });
    expect(memory.rpcs).toEqual([
      {
        name: 'rag_source_reconcile_run_record',
        args: {
          p_tenant_key: TENANT,
          p_connection_id: connection(null).id,
          p_origin: 'change_feed',
          p_status: 'completed',
          p_counts: { listed: 2, candidates: 2 },
          p_candidate_file_ids: ['file-a', 'file-b'],
        },
      },
    ]);
  });

  it('a failing bookkeeping call never blocks the removal', async () => {
    const memory = createNangoMemoryAdmin(seed(['file-a']).tables, { rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } }) });
    const result = await applySourceDeletions(connection('soft'), ['file-a'], 'change_feed', { admin: memory.admin as never });
    expect(result.removed).toBe(1);
  });

  it('raiseSourceAlert records the state on the connection row (no OBS-03 source rule yet)', async () => {
    const memory = seed([]);
    const stored = await raiseSourceAlert(connection(null), 'paused', { candidates: 6, total: 10 }, { admin: memory.admin as never });
    expect(stored).toBe('connection_status');
    expect(memory.tables.nango_connections?.[0]?.last_reconcile_status).toBe('paused');
    expect(memory.ops.filter((op) => op.operation === 'update')).toEqual([
      { table: 'nango_connections', operation: 'update', filters: [{ kind: 'eq', column: 'id', value: connection(null).id }], values: { last_reconcile_status: 'paused' } },
    ]);
  });
});
