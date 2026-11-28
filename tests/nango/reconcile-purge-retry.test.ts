import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

/**
 * D-15, C-10: each scheduled reconcile first retries the pending objects of purge records and runs the chat scrub
 * again for recent purges, within the run's deadline; a failure there never stops the connection reconciliation.
 */

vi.mock('@/lib/nango/source-alerts', () => ({ raiseSourceAlert: vi.fn(async () => 'connection_status') }));
vi.mock('@/lib/nango/client', () => ({ getNango: () => ({ proxy: vi.fn(), listRecords: vi.fn() }) }));
vi.mock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('neutral text')) }));
vi.mock('@/lib/nango/permission-sync', () => ({ notionWorkspaceId: vi.fn(async () => null), syncSourcePermissions: vi.fn(async () => ({ outcome: 'skipped' })) }));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => 'unified', processDocumentWithMetadata: vi.fn(async () => 'doc-new') }));
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
    retryPendingPurgeObjects: vi.fn(async () => ({ ok: true, records: 0, cleared: 0, stillPending: 0 })),
    rescrubRecentPurges: vi.fn(async () => ({ ok: true, records: 0, scrubbed: 0 })),
  };
});

import { runSourceReconcile, type SourceReconcileDeps } from '@/lib/nango/reconcile';

const OWNER: string = TWO_TENANT_IDS.userA;
const ROW = '00000000-0000-4000-8000-0000000f2101';

function db() {
  return createNangoMemoryAdmin(
    {
      nango_connections: [
        {
          id: ROW,
          connection_id: 'conn-retry',
          user_id: OWNER,
          provider: 'google-drive',
          deletion_mode: null,
          status: 'connected',
          last_full_reconcile_at: null,
          sync_folder_id: 'folder-root',
          sync_file_ids: null,
        },
      ],
      rag_source_reconcile_runs: [],
    },
    { rpc: () => ({ data: [{ run_id: 'run-1', expires_at: null }], error: null }) },
  );
}

type PurgeDeps = NonNullable<SourceReconcileDeps['purge']>;

describe('runSourceReconcile purge follow-ups (D-15, C-10)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  it('retries the pending purge objects and re-scrubs recent purges before the connections, and reports both counts', async () => {
    const order: string[] = [];
    const retry = vi.fn<PurgeDeps['retry']>(async (input) => {
      order.push('retry');
      expect(input.limit).toBe(50);
      expect(input.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, records: 1, cleared: 2, stillPending: 0 };
    });
    const rescrub = vi.fn<PurgeDeps['rescrub']>(async () => {
      order.push('rescrub');
      return { ok: true, records: 1, scrubbed: 1 };
    });
    const listFiles = vi.fn(async () => {
      order.push('list');
      return { fileIds: [], complete: true };
    });
    const memory = db();
    const result = await runSourceReconcile({ deadlineMs: 60_000, deps: { admin: memory.admin as never, listFiles, purge: { retry, rescrub } } });

    expect(order).toEqual(['retry', 'rescrub', 'list']);
    expect(result).toMatchObject({ processed: 1, purgeRetried: 2, purgeStillPending: 0, purgeRescrubbed: 1, purgeSkipped: 0 });
  });

  it('a retry failure keeps the run going: the connections are still reconciled and the failure is counted', async () => {
    const retry = vi.fn<PurgeDeps['retry']>(async () => {
      throw new Error('storage outage');
    });
    const rescrub = vi.fn<PurgeDeps['rescrub']>(async () => ({ ok: false, reason: 'unavailable' }));
    const listFiles = vi.fn(async () => ({ fileIds: [], complete: true }));
    const memory = db();
    const result = await runSourceReconcile({ deadlineMs: 60_000, deps: { admin: memory.admin as never, listFiles, purge: { retry, rescrub } } });

    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, purgeRetried: 0, purgeRescrubbed: 0, purgeFailed: 2 });
  });

  it('the retries share the deadline: with no time left they are skipped, reported, and nothing is called', async () => {
    const retry = vi.fn<PurgeDeps['retry']>(async () => ({ ok: true, records: 0, cleared: 0, stillPending: 0 }));
    const rescrub = vi.fn<PurgeDeps['rescrub']>(async () => ({ ok: true, records: 0, scrubbed: 0 }));
    const memory = db();
    const result = await runSourceReconcile({ deadlineMs: 0, deps: { admin: memory.admin as never, listFiles: vi.fn(), purge: { retry, rescrub } } });

    expect(retry).not.toHaveBeenCalled();
    expect(rescrub).not.toHaveBeenCalled();
    expect(result).toMatchObject({ purgeSkipped: 2, purgeRetried: 0, purgeRescrubbed: 0 });
  });

  it('a retry that runs out of its share of the deadline is aborted, counted as skipped, and the connections still run', async () => {
    let now = 1_000_000;
    const retry = vi.fn<PurgeDeps['retry']>(async (input) => {
      now += 40_000;
      await new Promise((resolve) => setTimeout(resolve, 5));
      input.signal.throwIfAborted();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const rescrub = vi.fn<PurgeDeps['rescrub']>(async () => ({ ok: true, records: 0, scrubbed: 0 }));
    const listFiles = vi.fn(async () => ({ fileIds: [], complete: true }));
    const memory = db();
    const result = await runSourceReconcile({
      deadlineMs: 60_000,
      now: () => now,
      deps: { admin: memory.admin as never, listFiles, purge: { retry, rescrub } },
    });

    expect(result.purgeSkipped).toBeGreaterThanOrEqual(1);
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it('the default deps are the purge library functions of @/lib/rag', async () => {
    const rag = await import('@/lib/rag');
    const memory = db();
    const result = await runSourceReconcile({ deadlineMs: 60_000, deps: { admin: memory.admin as never, listFiles: vi.fn(async () => ({ fileIds: [], complete: true })) } });
    expect(rag.retryPendingPurgeObjects).toHaveBeenCalledTimes(1);
    expect(rag.rescrubRecentPurges).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ purgeRetried: 0, purgeRescrubbed: 0 });
    const rows = memory.tables.nango_connections as Row[];
    expect(rows).toHaveLength(1);
  });
});
