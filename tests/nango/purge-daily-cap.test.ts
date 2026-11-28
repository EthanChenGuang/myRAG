import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TWO_TENANT_IDS } from '../../eval/harness/two-tenant.mts';
import { createNangoMemoryAdmin, type Row } from '../helpers/nango-memory-admin';

const state = vi.hoisted(() => ({
  failLineages: new Set<string>(),
  env: { RAG_SOURCE_PURGE_DAILY_CAP: '0' } as Record<string, string | undefined>,
}));

const purgeLineage = vi.hoisted(() =>
  vi.fn(async (_scope: unknown, lineageId: string) =>
    state.failLineages.has(lineageId)
      ? { ok: false as const, reason: 'unavailable' }
      : { ok: true as const, auditId: 'audit-1', lineageId, removed: {}, check: {} },
  ),
);
const raiseSourceAlert = vi.hoisted(() => vi.fn(async () => 'connection_status' as const));

vi.mock('@/lib/env', () => ({ env: state.env }));
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
    softDeleteLineage: vi.fn(async (_scope: unknown, lineageId: string) => ({ ok: true as const, outcome: 'deleted' as const, lineageId, jobId: null })),
    purgeLineage,
    removeDocumentObjects: vi.fn(async () => undefined),
    recomputeDirtyDupClusters: async () => ({ ok: true }),
    queueConfigFromProcessEnv: () => ({ ingestAsync: false }),
  };
});

import { applySourceDeletions, parsePurgeDailyCap, type SourceConnectionRow } from '@/lib/nango/source-deletions';

const OWNER: string = TWO_TENANT_IDS.userA;
const CONNECTION = 'conn-cap';
const CONNECTION_ROW_ID = '00000000-0000-4000-8000-00000000d029';
const TENANT = `u:${OWNER}`;

function connection(mode: 'soft' | 'purge' | null): SourceConnectionRow {
  return { id: CONNECTION_ROW_ID, connection_id: CONNECTION, user_id: OWNER, provider: 'google-drive', deletion_mode: mode };
}

/** A memory database whose purge RPCs follow the 0729 contract: a per-day counter and one held run. */
function seed(fileIds: string[], options: { cap?: number; reserveError?: boolean; holdError?: boolean; used?: number } = {}) {
  const counter = { used: options.used ?? 0 };
  const held: string[] = [];
  const memory = createNangoMemoryAdmin(
    {
      nango_connections: [{ ...connection('purge'), status: 'connected' }],
      nango_sync_records: fileIds.map((fileId) => ({
        id: `rec-${fileId}`,
        user_id: OWNER,
        connection_id: CONNECTION,
        file_id: fileId,
        file_name: `${fileId}.bin`,
        document_id: `doc-${fileId}`,
        status: 'completed',
      })),
      documents: fileIds.map((fileId) => ({
        id: `doc-${fileId}`,
        lineage_id: `line-${fileId}`,
        version: 1,
        tenant_key: TENANT,
        user_id: OWNER,
        source: 'nango',
        source_connection_id: CONNECTION,
        source_key: fileId,
        source_file_id: fileId,
      })) as Row[],
    },
    {
      rpc: (name, args) => {
        if (name === 'rag_source_purge_reserve') {
          if (options.reserveError) return { data: null, error: { code: 'XX000', message: 'unavailable' } };
          const cap = Number(args.p_cap);
          const granted = Math.min(Number(args.p_requested), Math.max(cap - counter.used, 0));
          counter.used += granted;
          return { data: granted, error: null };
        }
        if (name === 'rag_source_purge_release') {
          counter.used = Math.max(counter.used - Number(args.p_count), 0);
          return { data: counter.used, error: null };
        }
        if (name === 'rag_source_purge_hold') {
          if (options.holdError) return { data: null, error: { code: 'XX000', message: 'unavailable' } };
          for (const id of args.p_file_ids as string[]) if (!held.includes(id)) held.push(id);
          return { data: 'run-cap-1', error: null };
        }
        return { data: [{ run_id: 'run-1', expires_at: null }], error: null };
      },
    },
  );
  return { ...memory, counter, held };
}

const records = (memory: ReturnType<typeof seed>) => (memory.tables.nango_sync_records ?? []).map((row) => String(row.file_id)).sort();
const capRpcs = (memory: ReturnType<typeof seed>) => memory.rpcs.filter((call) => call.name.startsWith('rag_source_purge_')).map((call) => call.name);

describe('RAG_SOURCE_PURGE_DAILY_CAP on change-feed purges (D-49)', () => {
  beforeEach(() => {
    state.failLineages.clear();
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '0';
    purgeLineage.mockClear();
    raiseSourceAlert.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('cap 0 (default): a purge-mode change-feed batch of 4 issues no new call and purges 4, as before', async () => {
    const memory = seed(['a', 'b', 'c', 'd']);
    const result = await applySourceDeletions(connection('purge'), ['a', 'b', 'c', 'd'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 4, failed: 0, deferred: 0 });
    expect(capRpcs(memory)).toEqual([]);
    expect(memory.rpcs.map((call) => call.name)).toEqual(['rag_source_reconcile_run_record']);
    expect(records(memory)).toEqual([]);
    expect(raiseSourceAlert).not.toHaveBeenCalled();
  });

  it('cap 3: 3 of 4 purged, 1 held with its sync record, one hold call and one paused alert', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '3';
    const memory = seed(['a', 'b', 'c', 'd']);
    const result = await applySourceDeletions(connection('purge'), ['a', 'b', 'c', 'd'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 3, failed: 0, deferred: 0, held: 1 });
    expect(records(memory)).toEqual(['d']);
    expect(purgeLineage).toHaveBeenCalledTimes(3);
    expect(capRpcs(memory)).toEqual(['rag_source_purge_reserve', 'rag_source_purge_hold']);
    const reserve = memory.rpcs.find((call) => call.name === 'rag_source_purge_reserve')!;
    expect(reserve.args).toEqual({ p_tenant_key: TENANT, p_connection_id: CONNECTION_ROW_ID, p_requested: 4, p_cap: 3 });
    expect(memory.held).toEqual(['d']);
    expect(raiseSourceAlert).toHaveBeenCalledTimes(1);
    expect(raiseSourceAlert).toHaveBeenCalledWith(expect.objectContaining({ id: CONNECTION_ROW_ID }), 'paused', { held: 1, cap: 3 }, expect.anything());
    expect(memory.counter.used).toBe(3);
  });

  it('cap 3: a second batch the same day purges nothing and appends to the held run', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '3';
    const memory = seed(['a', 'b', 'c', 'd', 'e', 'f']);
    await applySourceDeletions(connection('purge'), ['a', 'b', 'c', 'd'], 'change_feed', { admin: memory.admin as never });
    purgeLineage.mockClear();
    const second = await applySourceDeletions(connection('purge'), ['e', 'f'], 'change_feed', { admin: memory.admin as never });
    expect(second).toEqual({ removed: 0, failed: 0, deferred: 0, held: 2 });
    expect(purgeLineage).not.toHaveBeenCalled();
    expect(memory.held).toEqual(['d', 'e', 'f']);
    expect(records(memory)).toEqual(['d', 'e', 'f']);
  });

  it('cap 3: a granted purge that fails is released', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '3';
    state.failLineages.add('line-b');
    const memory = seed(['a', 'b', 'c', 'd']);
    const result = await applySourceDeletions(connection('purge'), ['a', 'b', 'c', 'd'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 2, failed: 1, deferred: 0, held: 1 });
    expect(records(memory)).toEqual(['b', 'd']);
    const release = memory.rpcs.find((call) => call.name === 'rag_source_purge_release')!;
    expect(release.args.p_count).toBe(1);
    expect(memory.counter.used).toBe(2);
  });

  it('a reserve error purges nothing and reports the whole batch failed (fail closed)', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '3';
    const memory = seed(['a', 'b'], { reserveError: true });
    const result = await applySourceDeletions(connection('purge'), ['a', 'b'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 0, failed: 2, deferred: 0 });
    expect(purgeLineage).not.toHaveBeenCalled();
    expect(records(memory)).toEqual(['a', 'b']);
  });

  it('a hold error purges nothing, gives the reservation back and reports the whole batch failed', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '1';
    const memory = seed(['a', 'b', 'c'], { holdError: true });
    const result = await applySourceDeletions(connection('purge'), ['a', 'b', 'c'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 0, failed: 3, deferred: 0 });
    expect(purgeLineage).not.toHaveBeenCalled();
    expect(records(memory)).toEqual(['a', 'b', 'c']);
    expect(memory.counter.used).toBe(0);
    expect(raiseSourceAlert).not.toHaveBeenCalled();
  });

  it('within the cap nothing is held and the result has no held field', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '10';
    const memory = seed(['a', 'b']);
    const result = await applySourceDeletions(connection('purge'), ['a', 'b'], 'change_feed', { admin: memory.admin as never });
    expect(result).toEqual({ removed: 2, failed: 0, deferred: 0 });
    expect(capRpcs(memory)).toEqual(['rag_source_purge_reserve']);
  });

  it('soft and unset modes, reconcile and admin origins are never capped', async () => {
    state.env.RAG_SOURCE_PURGE_DAILY_CAP = '1';
    for (const [mode, origin] of [
      ['soft', 'change_feed'],
      [null, 'change_feed'],
      ['purge', 'reconcile'],
      ['purge', 'admin'],
    ] as const) {
      const memory = seed(['a', 'b', 'c']);
      const result = await applySourceDeletions(connection(mode), ['a', 'b', 'c'], origin, { admin: memory.admin as never });
      expect(result, `${mode}/${origin}`).toEqual({ removed: 3, failed: 0, deferred: 0 });
      expect(capRpcs(memory), `${mode}/${origin}`).toEqual([]);
    }
  });

  it('invalid cap values are 0 and warn once with [Source Reconcile]', async () => {
    expect(parsePurgeDailyCap('abc')).toBe(0);
    expect(parsePurgeDailyCap('-1')).toBe(0);
    expect(parsePurgeDailyCap('2.5')).toBe(0);
    expect(parsePurgeDailyCap('')).toBe(0);
    expect(parsePurgeDailyCap(undefined)).toBe(0);
    expect(parsePurgeDailyCap(' 25 ')).toBe(25);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const raw of ['abc', '-1', '2.5']) {
      state.env.RAG_SOURCE_PURGE_DAILY_CAP = raw;
      const memory = seed(['a']);
      const result = await applySourceDeletions(connection('purge'), ['a'], 'change_feed', { admin: memory.admin as never });
      expect(result).toEqual({ removed: 1, failed: 0, deferred: 0 });
      expect(capRpcs(memory)).toEqual([]);
    }
    const capWarnings = warn.mock.calls.filter((call) => call.some((part) => String(part).includes('RAG_SOURCE_PURGE_DAILY_CAP')));
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]!.some((part) => String(part).includes('Source Reconcile'))).toBe(true);
  });
});
