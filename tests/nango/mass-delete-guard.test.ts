import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin } from '../helpers/nango-memory-admin';

const raiseSourceAlert = vi.hoisted(() => vi.fn(async () => 'connection_status' as const));
const softDeleteLineage = vi.hoisted(() => vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true as const, outcome: 'deleted' as const, lineageId, jobId: null })));

vi.mock('@/lib/nango/source-alerts', () => ({ raiseSourceAlert }));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => 'unified', processDocumentWithMetadata: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => null }));
vi.mock('@/lib/rag', async () => {
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  return {
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage,
    removeDocumentObjects: vi.fn(async () => undefined),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
  };
});

import {
  applySourceDeletions,
  guardListingRemoval,
  parseMaxDeleteShare,
  shouldPauseListingRemoval,
  type SourceConnectionRow,
} from '@/lib/nango/source-deletions';

const OWNER = TWO_TENANT_IDS.userA;
const TENANT = `u:${OWNER}`;
const CONNECTION: SourceConnectionRow = {
  id: '00000000-0000-4000-8000-00000000d002',
  connection_id: 'conn-guard',
  user_id: OWNER,
  provider: 'dropbox',
  deletion_mode: null,
};

const ids = (count: number, prefix = 'file') => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

describe('mass-delete pause (D-09, D-33)', () => {
  beforeEach(() => {
    raiseSourceAlert.mockClear();
    softDeleteLineage.mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('4 of 10 (40 %) is not paused: under the floor of 5', () => {
    expect(shouldPauseListingRemoval(4, 10, 0.3)).toBe(false);
  });

  it('6 of 10 (60 %) is paused', () => {
    expect(shouldPauseListingRemoval(6, 10, 0.3)).toBe(true);
  });

  it('6 of 30 (20 %) is not paused', () => {
    expect(shouldPauseListingRemoval(6, 30, 0.3)).toBe(false);
  });

  it('with the share set to 1 nothing is paused', () => {
    expect(shouldPauseListingRemoval(10, 10, 1)).toBe(false);
    expect(shouldPauseListingRemoval(500, 500, 1)).toBe(false);
  });

  it('1 of 2 is never paused', () => {
    expect(shouldPauseListingRemoval(1, 2, 0.3)).toBe(false);
    expect(shouldPauseListingRemoval(1, 2, 0)).toBe(false);
  });

  it('an invalid share falls back to 0.3', () => {
    expect(parseMaxDeleteShare('0.5')).toBe(0.5);
    expect(parseMaxDeleteShare('1')).toBe(1);
    for (const bad of ['', 'abc', '-0.1', '0', '1.5', 'NaN', undefined]) expect(parseMaxDeleteShare(bad)).toBe(0.3);
  });

  it('a paused listing removes nothing, records one awaiting run with the six ids and raises one alert', async () => {
    const memory = createNangoMemoryAdmin({});
    const orphans = ids(6);
    const outcome = await guardListingRemoval({
      connection: CONNECTION,
      orphanFileIds: orphans,
      totalRecords: 10,
      listedCount: 4,
      origin: 'sync',
      complete: true,
      share: 0.3,
      admin: memory.admin as never,
    });
    expect(outcome.paused).toBe(true);
    expect(memory.ops.filter((op) => op.operation === 'delete')).toEqual([]);
    expect(memory.rpcs).toEqual([
      {
        name: 'rag_source_reconcile_run_record',
        args: {
          p_tenant_key: TENANT,
          p_connection_id: CONNECTION.id,
          p_origin: 'sync',
          p_status: 'awaiting_confirmation',
          p_counts: { listed: 4, total: 10, candidates: 6 },
          p_candidate_file_ids: orphans,
        },
      },
    ]);
    expect(raiseSourceAlert).toHaveBeenCalledTimes(1);
    expect(raiseSourceAlert).toHaveBeenCalledWith(CONNECTION, 'paused', { candidates: 6, total: 10 }, { admin: memory.admin });
  });

  it('a complete in-sync listing records one completed sync run', async () => {
    const memory = createNangoMemoryAdmin({});
    const outcome = await guardListingRemoval({
      connection: CONNECTION,
      orphanFileIds: [],
      totalRecords: 3,
      listedCount: 3,
      origin: 'sync',
      complete: true,
      share: 0.3,
      admin: memory.admin as never,
    });
    expect(outcome.paused).toBe(false);
    expect(memory.rpcs.map((call) => [call.args.p_origin, call.args.p_status])).toEqual([['sync', 'completed']]);
    expect(raiseSourceAlert).not.toHaveBeenCalled();
  });

  it('an incomplete listing that is not paused records an incomplete run, never a completed one', async () => {
    const memory = createNangoMemoryAdmin({});
    await guardListingRemoval({
      connection: CONNECTION,
      orphanFileIds: ['file-1'],
      totalRecords: 3,
      listedCount: 2,
      origin: 'scheduled',
      complete: false,
      share: 0.3,
      admin: memory.admin as never,
    });
    expect(memory.rpcs.map((call) => [call.args.p_origin, call.args.p_status])).toEqual([['scheduled', 'incomplete']]);
  });

  it('a change-feed batch is not share-guarded but is cut at the batch size and recorded as one change_feed run', async () => {
    const all = ids(60);
    const memory = createNangoMemoryAdmin({
      nango_sync_records: all.map((fileId) => ({
        id: `rec-${fileId}`,
        user_id: OWNER,
        connection_id: CONNECTION.connection_id,
        file_id: fileId,
        file_name: `${fileId}.bin`,
        document_id: null,
        status: 'completed',
      })),
    });
    const soft = { ...CONNECTION, deletion_mode: 'soft' };
    const result = await applySourceDeletions(soft, ids(55), 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 50, failed: 0, deferred: 5 });
    expect(memory.tables.nango_sync_records).toHaveLength(10);
    expect(memory.rpcs).toHaveLength(1);
    expect(memory.rpcs[0]?.args.p_origin).toBe('change_feed');
    expect(memory.rpcs[0]?.args.p_candidate_file_ids).toEqual(ids(50));
    expect(raiseSourceAlert).not.toHaveBeenCalled();
  });
});
