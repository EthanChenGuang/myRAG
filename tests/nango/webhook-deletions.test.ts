import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

const SIGNING_KEY = vi.hoisted(() => {
  const key = 'test-webhook-signing-key-placeholder';
  process.env.NANGO_WEBHOOK_SECRET = key;
  return key;
});

type ListCall = { providerConfigKey: string; connectionId: string; model: string; filter?: string; cursor?: string | null; limit?: number };

const state = vi.hoisted(() => ({
  enabled: true,
  memory: null as null | { admin: unknown },
  pages: [] as Array<{ records: unknown[]; next_cursor: string | null }>,
  listCalls: [] as ListCall[],
}));

const syncDocumentsForConnection = vi.hoisted(() => vi.fn(async () => ({ processed: 0 })));

vi.mock('@/lib/nango/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/nango/client')>('@/lib/nango/client');
  return {
    ...actual,
    isNangoEnabled: () => state.enabled,
    getNango: () => ({
      listRecords: async (input: ListCall) => {
        state.listCalls.push({ ...input });
        return state.pages.shift() ?? { records: [], next_cursor: null };
      },
    }),
  };
});
vi.mock('@/lib/nango/sync-manager', () => ({ syncDocumentsForConnection }));
vi.mock('@/lib/nango/document-adapter', () => ({ nangoPipeline: () => 'legacy', processDocumentWithMetadata: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.memory?.admin ?? null }));
vi.mock('@/lib/rag', async () => {
  const ingestScope = await vi.importActual<typeof import('@/lib/rag/tenant/ingest-scope')>('@/lib/rag/tenant/ingest-scope');
  const scopeModule = await vi.importActual<typeof import('@/lib/rag/tenant/scope')>('@/lib/rag/tenant/scope');
  return {
    isPurgeTombstoned: async () => ({ ok: true, tombstoned: false }),
    recomputeDirtyDupClusters: async () => ({ ok: true }),
    nangoOwnerScope: (input: { ownerUserId: string | null | undefined }) =>
      ingestScope.nangoOwnerScope({ ownerUserId: input.ownerUserId, deploymentMode: 'multi-tenant' }),
    scopeKey: scopeModule.scopeKey,
    softDeleteLineage: vi.fn(),
    removeDocumentObjects: vi.fn(async () => undefined),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
  };
});

import { POST } from '@/app/api/nango/webhook/route';
import { NangoRecordsFeed } from '@/lib/nango/change-feed';
import { handleSyncWebhook } from '@/lib/nango/webhook-deletions';

const OWNER: string = TWO_TENANT_IDS.userA;
const OTHER: string = TWO_TENANT_IDS.userB;
const CONNECTION = 'conn-webhook';
const CONNECTION_ROW_ID = '00000000-0000-4000-8000-00000000e001';
const MODEL = 'files';

function seed(syncedFileIds: string[]) {
  const memory = createNangoMemoryAdmin({
    nango_connections: [
      { id: CONNECTION_ROW_ID, connection_id: CONNECTION, user_id: OWNER, provider: 'box', deletion_mode: null, status: 'connected' },
    ],
    nango_sync_records: syncedFileIds.map((fileId) => ({
      id: `rec-${fileId}`,
      user_id: OWNER,
      connection_id: CONNECTION,
      file_id: fileId,
      file_name: `${fileId}-name.bin`,
      document_id: `doc-${fileId}`,
      status: 'completed',
    })),
    documents: syncedFileIds.map((fileId) => ({ id: `doc-${fileId}`, user_id: OWNER, source: 'nango' })),
    rag_source_delta_tokens: [],
  });
  state.memory = memory;
  return memory;
}

const deleted = (id: string, cursor: string) => ({ id, _nango_metadata: { last_action: 'DELETED', cursor } });
const fileIds = (count: number, prefix = 'file') => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
const pageOf = (ids: string[], next: string | null = null) => ({ records: ids.map((id) => deleted(id, `cur-${id}`)), next_cursor: next });

function syncBody(extra: Row = {}): Row {
  return {
    type: 'sync',
    connectionId: CONNECTION,
    providerConfigKey: 'box',
    syncName: 'documents',
    model: MODEL,
    success: true,
    modifiedAfter: '2026-11-01T00:00:00.000Z',
    responseResults: { added: 0, updated: 0, deleted: 2 },
    checkpoints: { from: 'prev-checkpoint', to: 'next-checkpoint' },
    ...extra,
  };
}

const hmac = (raw: string, key = SIGNING_KEY) => crypto.createHmac('sha256', key).update(raw).digest('hex');

function request(body: Row, headers: Record<string, string> | 'signed' = 'signed'): NextRequest {
  const raw = JSON.stringify(body);
  const sent = headers === 'signed' ? { 'X-Nango-Hmac-Sha256': hmac(raw) } : headers;
  return new NextRequest('http://localhost/api/nango/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sent },
    body: raw,
  });
}

async function deliver(body: Row, headers: Record<string, string> | 'signed' = 'signed') {
  const response = await POST(request(body, headers));
  return { status: response.status, body: (await response.json()) as unknown };
}

type Memory = ReturnType<typeof seed>;
const syncRecords = (memory: Memory) => (memory.tables.nango_sync_records ?? []).map((row) => String(row.file_id)).sort();
const storedCursor = (memory: Memory) =>
  (memory.tables.rag_source_delta_tokens ?? []).find(
    (row) => row.connection_id === CONNECTION_ROW_ID && row.feed === 'nango_records' && row.feed_key === MODEL,
  )?.delta_link ?? null;
const runs = (memory: Memory) => memory.rpcs.filter((call) => call.name === 'rag_source_reconcile_run_record').map((call) => call.args);
const changeFeedRuns = (memory: Memory) => runs(memory).filter((args) => args.p_origin === 'change_feed');

let logged: string[] = [];

describe('/api/nango/webhook sync deletions (D-04, D-05, D-32, D-33)', () => {
  beforeEach(() => {
    state.enabled = true;
    state.pages = [];
    state.listCalls = [];
    state.memory = null;
    syncDocumentsForConnection.mockClear();
    logged = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
  });

  it('a signed sync webhook removes the deleted files and stores the cursor after the batch', async () => {
    const memory = seed(['file-1', 'file-2', 'file-3']);
    state.pages = [pageOf(['file-1'], 'page-1'), pageOf(['file-2'])];

    const result = await deliver(syncBody());

    expect(result).toEqual({ status: 200, body: { received: true } });
    expect(state.listCalls).toHaveLength(2);
    expect(state.listCalls[0]).toMatchObject({ providerConfigKey: 'box', connectionId: CONNECTION, model: MODEL, filter: 'deleted', cursor: null });
    expect(state.listCalls[1].cursor).toBe('page-1');
    expect(changeFeedRuns(memory)).toHaveLength(1);
    expect(changeFeedRuns(memory)[0]).toMatchObject({ p_status: 'completed', p_candidate_file_ids: ['file-1', 'file-2'] });
    expect(syncRecords(memory)).toEqual(['file-3']);
    expect((memory.tables.documents ?? []).map((row) => row.id)).toEqual(['doc-file-3']);
    expect(storedCursor(memory)).toBe('cur-file-2');
    expect(syncDocumentsForConnection).not.toHaveBeenCalled();
  });

  it('takes the owner from the connection row, never from the body', async () => {
    const memory = seed(['file-1']);
    state.pages = [pageOf(['file-1'])];

    await deliver(syncBody({ userId: OTHER, user_id: OTHER, owner: OTHER }));

    const recordReads = memory.ops.filter((op) => op.table === 'nango_sync_records' && op.operation === 'select');
    expect(recordReads.length).toBeGreaterThan(0);
    for (const op of recordReads) {
      expect(op.filters).toContainEqual({ kind: 'eq', column: 'user_id', value: OWNER });
    }
    expect(memory.ops.some((op) => op.filters.some((filter) => filter.value === OTHER))).toBe(false);
    expect(syncRecords(memory)).toEqual([]);
  });

  it('refuses a wrong signature, a missing header and a body signed with the legacy header only', async () => {
    const memory = seed(['file-1']);
    state.pages = [pageOf(['file-1'])];
    const body = syncBody();
    const raw = JSON.stringify(body);
    const legacy = crypto.createHash('sha256').update(`${SIGNING_KEY}${raw}`).digest('hex');

    expect((await deliver(body, { 'X-Nango-Hmac-Sha256': hmac(raw, 'another-key') })).status).toBe(401);
    expect((await deliver(body, { 'X-Nango-Hmac-Sha256': hmac(raw).slice(0, 10) })).status).toBe(401);
    expect((await deliver(body, {})).status).toBe(401);
    expect((await deliver(body, { 'X-Nango-Signature': legacy })).status).toBe(401);
    expect((await deliver(body, { 'X-Nango-Signature': hmac(raw) })).status).toBe(401);
    expect(state.listCalls).toHaveLength(0);
    expect(syncRecords(memory)).toEqual(['file-1']);
  });

  it('answers 503 as today when Nango is disabled', async () => {
    seed(['file-1']);
    state.enabled = false;
    expect((await deliver(syncBody())).status).toBe(503);
    expect(state.listCalls).toHaveLength(0);
  });

  it('unknown connection: 200 with the same body as a known one and no records call', async () => {
    const memory = seed(['file-1']);
    const known = await deliver(syncBody());
    expect(state.listCalls).toHaveLength(1);
    state.listCalls = [];

    const unknown = await deliver(syncBody({ connectionId: 'conn-nobody' }));

    expect(unknown).toEqual(known);
    expect(unknown).toEqual({ status: 200, body: { received: true } });
    expect(state.listCalls).toHaveLength(0);
    expect(syncRecords(memory)).toEqual(['file-1']);
  });

  it('a duplicate delivery removes nothing twice and stores the same cursor', async () => {
    const memory = seed(['file-1', 'file-2']);
    state.pages = [pageOf(['file-1'])];
    await deliver(syncBody());
    expect(syncRecords(memory)).toEqual(['file-2']);
    expect(storedCursor(memory)).toBe('cur-file-1');

    state.pages = [pageOf(['file-1'])];
    const second = await deliver(syncBody());

    expect(second.status).toBe(200);
    expect(state.listCalls[1].cursor).toBe('cur-file-1');
    expect(syncRecords(memory)).toEqual(['file-2']);
    expect(storedCursor(memory)).toBe('cur-file-1');
    expect((memory.tables.rag_source_delta_tokens ?? []).length).toBe(1);
  });

  it('a deadline after the first page applies that page and stores only its cursor', async () => {
    const memory = seed(['file-1', 'file-2']);
    let clock = 0;
    const pages = [pageOf(['file-1'], 'page-1'), pageOf(['file-2'])];
    const client = {
      listRecords: async (input: ListCall) => {
        state.listCalls.push({ ...input });
        clock += 1_000;
        return pages.shift() ?? { records: [], next_cursor: null };
      },
    };

    const outcome = await handleSyncWebhook(syncBody() as never, {
      deadlineMs: 2_000,
      now: () => clock,
      admin: memory.admin as never,
      feedFor: ({ providerConfigKey, model }) => new NangoRecordsFeed({ providerConfigKey, model, client, now: () => clock }),
    });

    expect(state.listCalls).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'applied', removed: 1, failed: 0 });
    expect(syncRecords(memory)).toEqual(['file-2']);
    expect(storedCursor(memory)).toBe('cur-file-1');
  });

  it('a failed removal keeps the cursor so the next delivery reads the batch again', async () => {
    const memory = createNangoMemoryAdmin(
      {
        nango_connections: [{ id: CONNECTION_ROW_ID, connection_id: CONNECTION, user_id: OWNER, provider: 'box', deletion_mode: null }],
        nango_sync_records: [{ id: 'rec-file-1', user_id: OWNER, connection_id: CONNECTION, file_id: 'file-1', file_name: 'x', document_id: null, status: 'completed' }],
        rag_source_delta_tokens: [],
      },
      { failDelete: { table: 'nango_sync_records', error: { code: 'XX000', message: 'boom' } } },
    );
    state.memory = memory;
    state.pages = [pageOf(['file-1'])];

    expect((await deliver(syncBody())).status).toBe(200);
    expect(storedCursor(memory as Memory)).toBeNull();
    expect(changeFeedRuns(memory as Memory)[0]).toMatchObject({ p_status: 'failed' });
  });

  it('success false: 200 and no records call', async () => {
    const memory = seed(['file-1']);
    const result = await deliver(syncBody({ success: false, error: { type: 'script_error', description: 'failed' }, responseResults: undefined }));
    expect(result).toEqual({ status: 200, body: { received: true } });
    expect(state.listCalls).toHaveLength(0);
    expect(syncRecords(memory)).toEqual(['file-1']);
  });

  it('full sync (checkpoints.from null) with 7 of 10 deleted pauses: no removal, one awaiting run, one alert, cursor kept', async () => {
    const synced = fileIds(10);
    const memory = seed(synced);
    state.pages = [pageOf(synced.slice(0, 7))];

    expect((await deliver(syncBody({ checkpoints: { from: null, to: 'cp-1' } }))).status).toBe(200);

    expect(syncRecords(memory)).toEqual([...synced].sort());
    const awaiting = runs(memory).filter((args) => args.p_status === 'awaiting_confirmation');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ p_candidate_file_ids: synced.slice(0, 7), p_counts: { total: 10, candidates: 7 } });
    expect(changeFeedRuns(memory)).toHaveLength(0);
    const connection = (memory.tables.nango_connections ?? [])[0];
    expect(connection.last_reconcile_status).toBe('paused');
    expect(storedCursor(memory)).toBeNull();
  });

  it('the first run for a model without checkpoints and without a stored cursor is guarded the same way', async () => {
    const synced = fileIds(10);
    const memory = seed(synced);
    state.pages = [pageOf(synced.slice(0, 7))];

    await deliver(syncBody({ checkpoints: undefined }));

    expect(syncRecords(memory)).toHaveLength(10);
    expect(runs(memory).filter((args) => args.p_status === 'awaiting_confirmation')).toHaveLength(1);
  });

  it('incremental deletions are not share-guarded and are cut into batches of at most 50 with one run each', async () => {
    const synced = fileIds(70);
    const memory = seed(synced);
    state.pages = [pageOf(synced.slice(0, 60))];

    expect((await deliver(syncBody())).status).toBe(200);

    expect(syncRecords(memory)).toEqual([...synced.slice(60)].sort());
    const feedRuns = changeFeedRuns(memory);
    expect(feedRuns).toHaveLength(2);
    expect((feedRuns[0].p_candidate_file_ids as string[]).length).toBe(50);
    expect((feedRuns[1].p_candidate_file_ids as string[]).length).toBe(10);
    expect(runs(memory).some((args) => args.p_status === 'awaiting_confirmation')).toBe(false);
    expect(storedCursor(memory)).toBe('cur-file-60');
  });

  it('type auth: 200 and no document change', async () => {
    const memory = seed(['file-1']);
    const result = await deliver({ type: 'auth', connectionId: CONNECTION, providerConfigKey: 'box', operation: 'refresh', success: true });
    expect(result).toEqual({ status: 200, body: { received: true } });
    expect(state.listCalls).toHaveLength(0);
    expect(syncRecords(memory)).toEqual(['file-1']);
    expect(memory.ops.filter((op) => op.operation !== 'select')).toEqual([]);
  });

  it('a signed legacy sync.success body never starts a full sync', async () => {
    seed(['file-1']);
    const result = await deliver({ type: 'sync.success', connectionId: CONNECTION, providerConfigKey: 'box', responseResults: { added: 1, updated: 0, deleted: 0 } });
    expect(result.status).toBe(200);
    expect(syncDocumentsForConnection).not.toHaveBeenCalled();
    expect(state.listCalls).toHaveLength(0);
  });

  it('an integration key that does not match the connection reads nothing', async () => {
    const memory = seed(['file-1']);
    state.pages = [pageOf(['file-1'])];
    expect((await deliver(syncBody({ providerConfigKey: 'google-drive' }))).status).toBe(200);
    expect(state.listCalls).toHaveLength(0);
    expect(syncRecords(memory)).toEqual(['file-1']);
  });

  it('logs carry the connection id and counts only, never record payloads or file names', async () => {
    seed(['file-1', 'file-2']);
    state.pages = [pageOf(['file-1', 'file-2'])];
    await deliver(syncBody());
    const all = logged.join('\n');
    expect(all).not.toContain('-name.bin');
    expect(all).not.toContain('_nango_metadata');
    expect(all).not.toContain('cur-file');
  });
});
