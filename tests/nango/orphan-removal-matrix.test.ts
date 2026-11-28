import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';
import { createFakeConnector } from '../helpers/fake-connector';
import { startFakeGraph, type FakeGraph } from '../helpers/fake-graph';

/**
 * D-09 and D-48 (DATA-23): every connector path that removes orphans from a full listing removes nothing from an
 * incomplete listing, pauses a complete listing that would remove too much, and removes a small diff, in every
 * deletion mode. The static check at the end fails when a new call site is not one of the paths below.
 */

const state = vi.hoisted(() => ({ memory: null as null | { admin: unknown } }));

type ProxyRequest = { providerConfigKey: string; endpoint: string; data?: Record<string, unknown>; params?: Record<string, string> };

const remote = vi.hoisted(() => ({
  drive: {} as Record<string, Array<Record<string, unknown>[] | 'fail'>>,
  dropbox: {} as Record<string, { entries: Record<string, unknown>[]; has_more?: boolean }>,
  records: { records: [] as Record<string, unknown>[], next_cursor: null as string | null },
}));

const proxy = vi.hoisted(() =>
  vi.fn(async (request: ProxyRequest) => {
    if (request.providerConfigKey === 'google-drive') {
      const folder = /'([^']+)' in parents/.exec(request.params?.q ?? '')?.[1] ?? '';
      const pages = remote.drive[folder] ?? [[]];
      const index = request.params?.pageToken ? Number(request.params.pageToken.replace('tok-', '')) : 0;
      const page = pages[index];
      if (page === 'fail') throw new Error('proxy down');
      return { data: { files: page ?? [], ...(index + 1 < pages.length ? { nextPageToken: `tok-${index + 1}` } : {}) } };
    }
    if (request.providerConfigKey === 'dropbox') {
      return { data: remote.dropbox[String(request.data?.path ?? '')] ?? { entries: [] } };
    }
    throw new Error(`unexpected proxy ${request.providerConfigKey}`);
  }),
);
const listRecords = vi.hoisted(() => vi.fn(async () => remote.records));
const raiseSourceAlert = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 'connection_status' as const));
const softDeleteLineage = vi.hoisted(() =>
  vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true as const, outcome: 'deleted' as const, lineageId, jobId: null })),
);
const purgeLineage = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));

vi.mock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords }), isNangoEnabled: () => true }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.memory?.admin ?? null }));
vi.mock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn(async () => Buffer.from('neutral text')) }));
vi.mock('@/lib/nango/source-alerts', () => ({ raiseSourceAlert }));
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

import { removeOrphans, syncDocumentsForConnection } from '@/lib/nango/sync-manager';
import { syncSharePointConnection, type SharePointSyncHooks } from '@/lib/nango/sharepoint/sync';
import { handleSyncWebhook } from '@/lib/nango/webhook-deletions';
import type { GraphTransport } from '@/lib/nango/sharepoint/graph';

const OWNER: string = TWO_TENANT_IDS.userA;
const TENANT = `u:${OWNER}`;
const CONNECTION = 'conn-matrix';
const ROW_ID = '00000000-0000-4000-8000-00000000e282';
const SP_DRIVE = 'drive-a';
const SP_PRESENT = ['item-file-a', 'item-file-n'];

type Mode = null | 'soft' | 'purge';
type Scenario = 'incomplete' | 'pause' | 'remove';
type Memory = ReturnType<typeof createNangoMemoryAdmin>;

interface Plan {
  records: string[];
  missing: string[];
  listed: string[];
}

interface MatrixPath {
  name: string;
  provider: string;
  connection?: Row;
  plan(scenario: Scenario): Plan;
  run(memory: Memory, plan: Plan, complete: boolean): Promise<void>;
}

const ids = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

function genericPlan(scenario: Scenario): Plan {
  const records = scenario === 'pause' ? ids(10, 'file') : ids(3, 'file');
  const missing = scenario === 'pause' ? records.slice(0, 6) : records.slice(0, 1);
  return { records, missing, listed: records.filter((id) => !missing.includes(id)) };
}

const driveFile = (id: string): Row => ({ id, name: `${id}.bin`, mimeType: 'application/octet-stream' });
const dropboxFile = (id: string): Row => ({ '.tag': 'file', id, name: `${id}.bin`, path_display: `/${id}.bin` });
const recordsFile = (id: string): Row => ({ id, name: `${id}.bin` });

const sync = async (provider: string) => {
  await syncDocumentsForConnection(CONNECTION, provider);
};

const recordsPath = (provider: string): MatrixPath => ({
  name: `records fallback (${provider})`,
  provider,
  plan: genericPlan,
  async run(_memory, plan, complete) {
    remote.records = { records: plan.listed.map(recordsFile), next_cursor: complete ? null : 'cursor-2' };
    await sync(provider);
  },
});

let graph: FakeGraph | undefined;

const PATHS: MatrixPath[] = [
  {
    name: 'Google Drive single folder',
    provider: 'google-drive',
    connection: { sync_folder_id: 'folder-one' },
    plan: genericPlan,
    async run(_memory, plan, complete) {
      remote.drive['folder-one'] = complete ? [plan.listed.map(driveFile)] : [plan.listed.map(driveFile), 'fail'];
      await sync('google-drive');
    },
  },
  {
    name: 'Google Drive multi-folder',
    provider: 'google-drive',
    connection: { sync_folder_id: 'multi-folder-mode', sync_file_ids: ['folder-a', 'folder-b'] },
    plan: genericPlan,
    async run(_memory, plan, complete) {
      const half = Math.ceil(plan.listed.length / 2);
      remote.drive['folder-a'] = [plan.listed.slice(0, half).map(driveFile)];
      remote.drive['folder-b'] = complete ? [plan.listed.slice(half).map(driveFile)] : [plan.listed.slice(half).map(driveFile), 'fail'];
      await sync('google-drive');
    },
  },
  {
    name: 'generic multi-folder (Dropbox)',
    provider: 'dropbox',
    connection: { sync_folder_id: 'multi-folder-mode', sync_file_ids: ['/a', '/b'] },
    plan: genericPlan,
    async run(_memory, plan, complete) {
      const half = Math.ceil(plan.listed.length / 2);
      remote.dropbox['/a'] = { entries: plan.listed.slice(0, half).map(dropboxFile) };
      remote.dropbox['/b'] = { entries: plan.listed.slice(half).map(dropboxFile), has_more: !complete };
      await sync('dropbox');
    },
  },
  {
    name: 'generic single folder (Dropbox)',
    provider: 'dropbox',
    plan: genericPlan,
    async run(_memory, plan, complete) {
      remote.dropbox[''] = { entries: plan.listed.map(dropboxFile), has_more: !complete };
      await sync('dropbox');
    },
  },
  recordsPath('box'),
  recordsPath('confluence'),
  {
    name: 'scheduled reconcile',
    provider: 'dropbox',
    plan: genericPlan,
    async run(memory, plan, complete) {
      const row = (memory.tables.nango_connections ?? [])[0] as never;
      await removeOrphans(row, plan.listed, 'scheduled', { complete, admin: memory.admin as never });
    },
  },
  {
    name: 'webhook full-sync diff',
    provider: 'box',
    plan: genericPlan,
    async run(memory, plan, complete) {
      const deletedPage = plan.missing.map((fileId, index) => ({ fileId, deleted: true, kind: 'file' as const, cursor: `cur-${index}` }));
      const connector = createFakeConnector({ files: plan.listed, pages: complete ? [deletedPage] : [deletedPage, []] });
      connector.markFullListing(true);
      await handleSyncWebhook(
        { type: 'sync', connectionId: CONNECTION, providerConfigKey: 'box', model: 'files', success: true, checkpoints: { from: null, to: 'cp-1' } } as never,
        { deadlineMs: 15_000, admin: memory.admin as never, feedFor: () => connector },
      );
    },
  },
  {
    name: 'SharePoint/OneDrive completed enumeration',
    provider: 'sharepoint-online',
    connection: { metadata: { source_scope: { sites: [], drives: [], folders: [{ id: 'item-folder-1', name: 'Folder 1', driveId: SP_DRIVE }] } } },
    plan(scenario) {
      const missing = scenario === 'pause' ? ids(6, 'item-old') : ids(1, 'item-old');
      return { records: [...SP_PRESENT, ...missing], missing, listed: SP_PRESENT };
    },
    async run(memory, _plan, complete) {
      graph = await startFakeGraph('drive-delta-scope');
      let clock = 1_000_000;
      const inner = graph.transport();
      let first = true;
      const transport: GraphTransport = async (request) => {
        const response = await inner(request);
        if (first && !complete) clock += 60_000;
        first = false;
        return response;
      };
      const hooks: SharePointSyncHooks = {
        markSourceSeen: vi.fn(async () => undefined),
        isSupportedFile: () => false,
        ownerOnlyLabel: (userId: string) => [`u:${userId.toLowerCase()}`],
        processDocument: vi.fn(async () => null) as unknown as SharePointSyncHooks['processDocument'],
        fetchContent: vi.fn(async () => Buffer.from('neutral text')),
      };
      await syncSharePointConnection(CONNECTION, memory.admin as never, hooks, { transport, now: () => clock, deadlineMs: 30_000 });
    },
  },
];

const MODES: Mode[] = [null, 'soft', 'purge'];
const SCENARIOS: Scenario[] = ['incomplete', 'pause', 'remove'];

function seed(matrixPath: MatrixPath, mode: Mode, plan: Plan): Memory {
  const memory = createNangoMemoryAdmin(
    {
      nango_connections: [
        {
          id: ROW_ID,
          connection_id: CONNECTION,
          user_id: OWNER,
          provider: matrixPath.provider,
          deletion_mode: mode,
          status: 'connected',
          sync_folder_id: null,
          sync_file_ids: null,
          metadata: {},
          ...matrixPath.connection,
        },
      ],
      nango_sync_records: plan.records.map((fileId) => ({
        id: `rec-${fileId}`,
        user_id: OWNER,
        connection_id: CONNECTION,
        provider: matrixPath.provider,
        file_id: fileId,
        file_name: `${fileId}.bin`,
        document_id: `doc-${fileId}`,
        status: 'completed',
        metadata: { drive_id: SP_DRIVE },
      })),
      documents: plan.records.map((fileId) => ({
        id: `doc-${fileId}`,
        lineage_id: `lin-${fileId}`,
        user_id: OWNER,
        tenant_key: TENANT,
        source: 'nango',
        source_connection_id: CONNECTION,
        source_key: fileId,
        is_current: true,
      })),
      rag_source_delta_tokens: [],
    },
    { storeWrites: true },
  );
  state.memory = memory;
  return memory;
}

const recordIds = (memory: Memory) => (memory.tables.nango_sync_records ?? []).map((record) => String(record.file_id)).sort();
const statuses = (memory: Memory) =>
  memory.rpcs.filter((call) => call.name === 'rag_source_reconcile_run_record').map((call) => String(call.args.p_status));

beforeEach(() => {
  remote.drive = {};
  remote.dropbox = {};
  remote.records = { records: [], next_cursor: null };
  raiseSourceAlert.mockClear();
  softDeleteLineage.mockClear();
  purgeLineage.mockClear();
  for (const level of ['log', 'warn', 'error', 'debug', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(async () => {
  const running = graph;
  graph = undefined;
  await running?.close();
});

describe('orphan removal matrix: path × mode × listing (D-09, D-48)', () => {
  for (const matrixPath of PATHS) {
    describe(matrixPath.name, () => {
      for (const mode of MODES) {
        for (const scenario of SCENARIOS) {
          it(`mode ${mode ?? 'NULL'}: ${scenario}`, async () => {
            const plan = matrixPath.plan(scenario);
            const memory = seed(matrixPath, mode, plan);
            await matrixPath.run(memory, plan, scenario !== 'incomplete');

            if (scenario === 'remove') {
              expect(recordIds(memory)).toEqual(plan.records.filter((id) => !plan.missing.includes(id)).sort());
              expect(statuses(memory)).not.toContain('awaiting_confirmation');
              expect(raiseSourceAlert).not.toHaveBeenCalled();
              if (mode === 'soft') expect(softDeleteLineage.mock.calls.map((call) => call[1])).toEqual(plan.missing.map((id) => `lin-${id}`));
              if (mode === 'purge') expect(purgeLineage).toHaveBeenCalledTimes(plan.missing.length);
              return;
            }

            expect(recordIds(memory)).toEqual([...plan.records].sort());
            expect(softDeleteLineage).not.toHaveBeenCalled();
            expect(purgeLineage).not.toHaveBeenCalled();
            expect(statuses(memory)).not.toContain('completed');
            if (scenario === 'pause') {
              expect(statuses(memory).filter((status) => status === 'awaiting_confirmation')).toHaveLength(1);
              expect(raiseSourceAlert).toHaveBeenCalledTimes(1);
              expect(raiseSourceAlert.mock.calls[0]?.[1]).toBe('paused');
            } else {
              expect(statuses(memory)).not.toContain('awaiting_confirmation');
              expect(raiseSourceAlert).not.toHaveBeenCalled();
            }
          });
        }
      }
    });
  }
});

const NANGO_DIR = path.resolve(__dirname, '../../src/lib/nango');
const COVERED_FILES = ['reconcile.ts', 'sharepoint/sync.ts', 'sync-manager.ts', 'webhook-deletions.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

const callsOf = (text: string, pattern: RegExp) =>
  text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line) && !/\bfunction\s+\w+\s*\(/.test(line))
    .filter((line) => pattern.test(line));

describe('static check: every orphan-removal call site is a matrix path (D-48)', () => {
  it('the files calling deleteOrphanedDocuments, removeOrphans or guardListingRemoval are the covered files', () => {
    const callers = sourceFiles(NANGO_DIR)
      .filter((file) => callsOf(readFileSync(file, 'utf8'), /\b(deleteOrphanedDocuments|removeOrphans|guardListingRemoval)\s*\(/).length > 0)
      .map((file) => path.relative(NANGO_DIR, file).split(path.sep).join('/'))
      .sort();
    expect(callers).toEqual(COVERED_FILES);
  });

  it('full-listing applySourceDeletions calls (origin reconcile) exist only in the covered removal paths', () => {
    const callers = sourceFiles(NANGO_DIR)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return /applySourceDeletions\([\s\S]{0,200}?'reconcile'/.test(text.replace(/export async function applySourceDeletions\(/, ''));
      })
      .map((file) => path.relative(NANGO_DIR, file).split(path.sep).join('/'))
      .sort();
    expect(callers).toEqual(['sharepoint/sync.ts', 'sync-manager.ts']);
  });

  it('deleteOrphanedDocuments takes the listing completeness as a required argument', () => {
    const text = readFileSync(path.join(NANGO_DIR, 'sync-manager.ts'), 'utf8');
    const signature = /async function deleteOrphanedDocuments\(([\s\S]*?)\): Promise<number>/.exec(text)?.[1] ?? '';
    expect(signature).toMatch(/\blistingComplete: boolean,/);
  });
});
