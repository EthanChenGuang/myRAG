import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';

/**
 * D-28 characterization: the ordered table reads and deletes, the soft-delete and object-removal calls and the
 * error and warning log lines of today's orphan deletion, for legacy or unified pipeline by async off or on.
 * `RECORD=1 npx vitest run tests/nango/default-deletion-characterization.test.ts` rewrites the fixture; the normal run
 * replays the scenario and deep-compares it. Inserts, upserts and updates are ingest bookkeeping and are not recorded.
 */

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/nango/default-deletion-calls.json', import.meta.url));
const RECORD = process.env.RECORD === '1';

const OWNER = TWO_TENANT_IDS.userA;
const CONNECTION = 'conn-char';
const FOLDER = 'folder-char';
const TENANT = `u:${OWNER}`;
const LINEAGE = (n: number) => `00000000-0000-4000-8000-00000000c${String(n).padStart(3, '0')}`;

type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in'; column: string; value: unknown };
type RecordedCall = { table: string; operation: 'select' | 'delete'; filters: Filter[] };
type DbError = { message: string; code: string };
type LogLine = { level: 'error' | 'warn'; component: string; message: string; detail: unknown };

type Pipeline = 'legacy' | 'unified';
type Scenario = 'removes' | 'fails';

interface Case {
  pipeline: Pipeline;
  ingestAsync: boolean;
  scenario: Scenario;
}

interface Recording {
  calls: RecordedCall[];
  softDeleteLineage: unknown[][];
  removeDocumentObjects: unknown[];
  logs: LogLine[];
  deleted: number;
  remainingSyncRecords: string[];
  remainingDocuments: string[];
}

const CASES: Case[] = (['legacy', 'unified'] as const).flatMap((pipeline) =>
  [false, true].flatMap((ingestAsync) => (['removes', 'fails'] as const).map((scenario) => ({ pipeline, ingestAsync, scenario }))),
);

const caseId = (c: Case) => `${c.pipeline}/async-${c.ingestAsync ? 'on' : 'off'}/${c.scenario}`;

/** What fails in the `fails` scenario for each combination. */
function failureOf(c: Case): { table: string; error: DbError } | 'soft_delete' | null {
  if (c.scenario !== 'fails') return null;
  // Legacy: the document named by the sync record cannot be deleted (single-tenant has no chunk cascade, RESEARCH Q1).
  if (c.pipeline === 'legacy') {
    return { table: 'documents', error: { message: 'update or delete on table "documents" violates foreign key constraint', code: '23503' } };
  }
  if (c.ingestAsync) return 'soft_delete';
  return { table: 'document_chunks', error: { message: 'chunk delete refused', code: 'XX000' } };
}

function createMemoryDb(seed: Record<string, Row[]>, failDelete: { table: string; error: DbError } | null) {
  const tables: Record<string, Row[]> = { nango_connections: [], nango_sync_records: [], documents: [], document_chunks: [], ...seed };
  const calls: RecordedCall[] = [];
  function from(table: string) {
    let op: 'select' | 'delete' | 'write' = 'select';
    const filters: Filter[] = [];
    const match = (row: Row) =>
      filters.every((entry) => (entry.kind === 'eq' ? row[entry.column] === entry.value : (entry.value as unknown[]).includes(row[entry.column])));
    const run = () => {
      if (op === 'write') return { data: null, error: null };
      calls.push({ table, operation: op, filters: filters.map((entry) => ({ ...entry, value: Array.isArray(entry.value) ? [...entry.value] : entry.value })) });
      const rows = tables[table] ?? [];
      const matched = rows.filter(match);
      if (op === 'delete') {
        if (failDelete && failDelete.table === table) return { data: null, error: failDelete.error };
        tables[table] = rows.filter((row) => !matched.includes(row));
      }
      return { data: matched, error: null };
    };
    const builder = {
      select: () => builder,
      delete() {
        op = 'delete';
        return builder;
      },
      insert() {
        op = 'write';
        return builder;
      },
      upsert() {
        op = 'write';
        return builder;
      },
      update() {
        op = 'write';
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
        const result = run();
        const found = Array.isArray(result.data) ? result.data[0] : undefined;
        return Promise.resolve({ data: found ?? null, error: found ? null : { message: 'not found' } });
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return builder;
  }
  // Bookkeeping rpc calls (06.3-05 run records) are answered but kept outside the compared call list.
  const rpc = async () => ({ data: [{ run_id: 'run-char', expires_at: null }], error: null });
  return { tables, calls, admin: { from, rpc } };
}

const listing = { files: [] as Row[] };
const proxy = vi.fn(async () => ({ data: { files: listing.files } }));

function seed(failDelete: { table: string; error: DbError } | null) {
  const record = (id: string, fileId: string, documentId: string): Row => ({
    id,
    user_id: OWNER,
    connection_id: CONNECTION,
    file_id: fileId,
    file_name: `${fileId}.bin`,
    document_id: documentId,
    status: 'completed',
  });
  const document = (id: string, fileId: string, lineage: string): Row => ({
    id,
    lineage_id: lineage,
    version: 1,
    tenant_key: TENANT,
    user_id: OWNER,
    source: 'nango',
    source_connection_id: CONNECTION,
    source_file_id: fileId,
    source_key: fileId,
    original_path: `${TENANT}/${lineage}/1/original.bin`,
    processing_state: null,
  });
  return createMemoryDb(
    {
      nango_connections: [{ id: 'row-char', connection_id: CONNECTION, user_id: OWNER, provider: 'google-drive', sync_folder_id: FOLDER, sync_file_ids: null }],
      nango_sync_records: [record('rec-a', 'file-a', 'doc-a'), record('rec-b', 'file-b', 'doc-b'), record('rec-c', 'file-c', 'doc-c')],
      documents: [document('doc-a', 'file-a', LINEAGE(1)), document('doc-b', 'file-b', LINEAGE(2)), document('doc-c', 'file-c', LINEAGE(3))],
      document_chunks: [{ id: 'chunk-c', document_id: 'doc-c' }],
    },
    failDelete,
  );
}

function detailOf(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Error) return { message: value.message };
  if (value && typeof value === 'object' && 'message' in value) {
    const { message, code } = value as { message: unknown; code?: unknown };
    return code === undefined ? { message } : { message, code };
  }
  return value;
}

async function replay(c: Case): Promise<Recording> {
  const failure = failureOf(c);
  const memory = seed(failure && failure !== 'soft_delete' ? failure : null);
  // A complete single-page listing; .bin files are not a supported type, so nothing is ingested.
  listing.files = ['file-a', 'file-b'].map((id) => ({ id, name: `${id}.bin`, mimeType: 'application/octet-stream' }));

  const softDeleteLineage = vi.fn(async (_scope: unknown, lineageId: string, _source: string, _options: { signal: AbortSignal }) =>
    failure === 'soft_delete' ? { ok: false, reason: 'unavailable' } : { ok: true, outcome: 'deleted', lineageId, jobId: null },
  );
  const removeDocumentObjects = vi.fn(async () => undefined);

  vi.resetModules();
  const identity = await vi.importActual<typeof import('@/lib/rag/ingest/identity')>('@/lib/rag/ingest/identity');
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memory.admin }));
  vi.doMock('@/lib/nango/client', () => ({ getNango: () => ({ proxy, listRecords: vi.fn() }) }));
  vi.doMock('@/lib/nango/file-fetcher', () => ({ fetchFileContent: vi.fn() }));
  vi.doMock('@/lib/document-processor', () => ({ processDocument: vi.fn() }));
  vi.doMock('@/lib/nango/document-adapter', () => ({ processDocumentWithMetadata: vi.fn(), nangoPipeline: () => c.pipeline }));
  vi.doMock('@/lib/rag/ingest/queue-config', () => ({ queueConfigFromProcessEnv: () => ({ ingestAsync: c.ingestAsync }), resetQueueConfigForTests: () => {} }));
  vi.doMock('@/lib/rag', () => ({
    ingest: vi.fn(),
    buildSourceKey: identity.buildSourceKey,
    isPurgeTombstoned: async () => ({ ok: true, tombstoned: false }),
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    currentIngestConfig: () => ({ pipeline: c.pipeline }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage,
    removeDocumentObjects,
    recomputeDirtyDupClusters: async () => ({ ok: true, skipped: true }),
    queueConfigFromProcessEnv: () => ({ ingestAsync: c.ingestAsync }),
  }));
  const { syncDocumentsForConnection } = await import('@/lib/nango/sync-manager');
  const { logger } = await import('@/lib/logger');
  const logs: LogLine[] = [];
  vi.spyOn(logger, 'error').mockImplementation((component: string, message: string, detail?: unknown) => {
    logs.push({ level: 'error', component, message, detail: detailOf(detail) });
  });
  vi.spyOn(logger, 'warn').mockImplementation((component: string, message: string, detail?: unknown) => {
    logs.push({ level: 'warn', component, message, detail: detailOf(detail) });
  });

  const stats = await syncDocumentsForConnection(CONNECTION, 'google-drive');

  return {
    calls: memory.calls,
    softDeleteLineage: softDeleteLineage.mock.calls.map(([scope, lineageId, source]) => [scope, lineageId, source]),
    removeDocumentObjects: removeDocumentObjects.mock.calls.map((args) => (args as unknown[])[0]),
    logs,
    deleted: stats.deleted,
    remainingSyncRecords: (memory.tables.nango_sync_records ?? []).map((row) => String(row.id)).sort(),
    remainingDocuments: (memory.tables.documents ?? []).map((row) => String(row.id)).sort(),
  };
}

interface Fixture {
  recorded_from: string;
  recorded_with: string;
  cases: Record<string, Recording>;
}

const recorded: Record<string, Recording> = {};

describe('default orphan deletion is unchanged (D-28 characterization)', () => {
  beforeEach(() => {
    proxy.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    for (const name of ['@/lib/supabase', '@/lib/nango/client', '@/lib/nango/file-fetcher', '@/lib/document-processor', '@/lib/nango/document-adapter', '@/lib/rag', '@/lib/rag/ingest/queue-config']) {
      vi.doUnmock(name);
    }
    if (RECORD && Object.keys(recorded).length === CASES.length) {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const fixture: Fixture = {
        recorded_from: sha,
        recorded_with:
          'syncDocumentsForConnection on one Google Drive single-folder connection with three sync records and a complete listing without file-c, in-memory admin client; nangoPipeline and ingestAsync mocked per case',
        cases: Object.fromEntries(CASES.map((c) => [caseId(c), recorded[caseId(c)]])),
      };
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    }
  });

  it.each(CASES.map((c) => [caseId(c), c] as const))('%s replays the recorded calls', async (id, c) => {
    const replayed = await replay(c);
    if (RECORD) {
      recorded[id] = replayed;
      return;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
    expect(fixture.recorded_from).toMatch(/^[0-9a-f]{40}$/);
    expect(replayed).toEqual(fixture.cases[id]);
  });
});
