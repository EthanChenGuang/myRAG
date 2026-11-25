import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  effectiveLogMode,
  resetTenantSettingsCache,
  setTenantFeedbackSettings,
  SETTINGS_CACHE_TTL_MS,
} from '@/lib/rag/feedback-loop/settings';
import { buildRetrievalLogRow, writeRetrievalLog } from '@/lib/rag/feedback-loop/retrieval-log';
import type { RetrievalLogLevel } from '@/lib/rag/feedback-loop/config';
import type { RetrievalResult } from '@/lib/rag/types';

const ORG = '22222222-2222-4222-8222-222222222222';
const TENANT = `o:${ORG}`;
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const QUERY = 'synthetic question about the second report';

interface FakeDb {
  client: SupabaseClient;
  settingsReads: number;
  inserts: Array<Record<string, unknown>>;
  upserts: Array<Record<string, unknown>>;
  setting: string | null;
  failRead: boolean;
}

/** A settings table and a retrieval log table in memory; every settings read is counted. */
function fakeDb(setting: string | null = null): FakeDb {
  const state: FakeDb = { client: null as unknown as SupabaseClient, settingsReads: 0, inserts: [], upserts: [], setting, failRead: false };
  const client = {
    from(table: string) {
      let pendingInsert: Record<string, unknown> | null = null;
      let pendingUpsert: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'abortSignal', 'delete']) builder[method] = () => builder;
      builder.insert = (row: Record<string, unknown>) => {
        pendingInsert = row;
        return builder;
      };
      builder.upsert = (row: Record<string, unknown>) => {
        pendingUpsert = row;
        return builder;
      };
      const settle = () => {
        if (table === 'rag_tenant_feedback_settings') {
          if (pendingUpsert) {
            state.upserts.push(pendingUpsert);
            state.setting = String(pendingUpsert.retrieval_log);
            return { data: { ...pendingUpsert, updated_at: '2026-11-25T00:00:00.000Z' }, error: null };
          }
          state.settingsReads += 1;
          if (state.failRead) return { data: null, error: { message: 'down', code: 'PGRST000' } };
          return { data: state.setting === null ? null : { tenant_key: TENANT, retrieval_log: state.setting }, error: null };
        }
        if (pendingInsert) {
          state.inserts.push(pendingInsert);
          return { data: { id: 'row-1', tenant_key: TENANT }, error: null };
        }
        return { data: null, error: null };
      };
      builder.maybeSingle = () => Promise.resolve(settle());
      builder.single = () => Promise.resolve(settle());
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(onFulfilled, onRejected);
      return builder;
    },
  };
  state.client = client as unknown as SupabaseClient;
  return state;
}

function result(): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    traceId: 'b'.repeat(32),
  } as unknown as RetrievalResult;
}

function maskedRow() {
  return buildRetrievalLogRow({
    result: result(),
    tenantKey: TENANT,
    stageLatency: {},
    latencyMs: 5,
    logContext: { channel: 'chat' },
    mode: 'masked_query',
    query: QUERY,
  });
}

beforeEach(() => {
  resetTenantSettingsCache();
});

afterEach(() => {
  resetTenantSettingsCache();
});

describe('effectiveLogMode (D-06)', () => {
  const cases: Array<[RetrievalLogLevel, string | null, RetrievalLogLevel]> = [
    ['masked_query', null, 'masked_query'],
    ['masked_query', 'inherit', 'masked_query'],
    ['masked_query', 'ids', 'ids'],
    ['masked_query', 'off', 'off'],
    ['ids', 'inherit', 'ids'],
    ['ids', 'ids', 'ids'],
    ['ids', 'off', 'off'],
    ['off', 'inherit', 'off'],
    ['off', 'ids', 'off'],
  ];

  it.each(cases)('global %s with tenant %s gives %s; a tenant never raises the level', async (global, tenant, expected) => {
    const db = fakeDb(tenant);
    expect(await effectiveLogMode(TENANT, { client: db.client, globalLevel: global })).toBe(expected);
  });

  it('a tenant row holding an unknown level is treated as off', async () => {
    const db = fakeDb('masked_query');
    expect(await effectiveLogMode(TENANT, { client: db.client, globalLevel: 'masked_query' })).toBe('off');
  });

  it('global off reads no settings at all', async () => {
    const db = fakeDb('inherit');
    expect(await effectiveLogMode(TENANT, { client: db.client, globalLevel: 'off' })).toBe('off');
    expect(db.settingsReads).toBe(0);
  });

  it('caches the tenant row for 60 s in process', async () => {
    const db = fakeDb('ids');
    let now = 1_000_000;
    const deps = { client: db.client, globalLevel: 'masked_query' as const, now: () => now };
    expect(await effectiveLogMode(TENANT, deps)).toBe('ids');
    now += 30_000;
    expect(await effectiveLogMode(TENANT, deps)).toBe('ids');
    expect(db.settingsReads).toBe(1);
    db.setting = 'off';
    now += SETTINGS_CACHE_TTL_MS + 1_000 - 30_000;
    expect(await effectiveLogMode(TENANT, deps)).toBe('off');
    expect(db.settingsReads).toBe(2);
  });

  it('fails closed to off with one [Feedback Loop] line when the settings read fails, and does not cache the failure', async () => {
    const db = fakeDb('inherit');
    db.failRead = true;
    const lines: string[] = [];
    const deps = { client: db.client, globalLevel: 'masked_query' as const, log: (line: string) => lines.push(line) };
    expect(await effectiveLogMode(TENANT, deps)).toBe('off');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[Feedback Loop\] /);
    expect(lines[0]).not.toContain(ORG);
    db.failRead = false;
    expect(await effectiveLogMode(TENANT, deps)).toBe('masked_query');
  });

  it('fails closed when there is no client or the tenant key is malformed', async () => {
    const lines: string[] = [];
    expect(await effectiveLogMode(TENANT, { client: null, globalLevel: 'masked_query', log: (line) => lines.push(line) })).toBe('off');
    expect(await effectiveLogMode('o:not-a-uuid', { client: fakeDb().client, globalLevel: 'masked_query', log: (line) => lines.push(line) })).toBe('off');
  });

  it('setTenantFeedbackSettings upserts with updated_by and the next read sees the new value at once', async () => {
    const db = fakeDb('inherit');
    const deps = { client: db.client, globalLevel: 'masked_query' as const };
    expect(await effectiveLogMode(TENANT, deps)).toBe('masked_query');
    const stored = await setTenantFeedbackSettings(db.client, { tenantKey: TENANT, retrievalLog: 'ids', updatedBy: ADMIN });
    expect(stored).toMatchObject({ tenant_key: TENANT, retrieval_log: 'ids', updated_by: ADMIN });
    expect(db.upserts).toEqual([expect.objectContaining({ tenant_key: TENANT, retrieval_log: 'ids', updated_by: ADMIN })]);
    expect(await effectiveLogMode(TENANT, deps)).toBe('ids');
  });
});

describe('writeRetrievalLog applies the tenant setting (D-05, D-06)', () => {
  it('writes no row for a tenant that opted out', async () => {
    const db = fakeDb('off');
    await writeRetrievalLog(maskedRow(), { expectedTenantKey: TENANT, client: db.client, settings: { globalLevel: 'masked_query' }, log: () => {} });
    expect(db.inserts).toHaveLength(0);
  });

  it('stores no query text or fingerprint for a tenant at ids', async () => {
    const db = fakeDb('ids');
    const row = maskedRow();
    expect(row.query_masked).not.toBeNull();
    await writeRetrievalLog(row, { expectedTenantKey: TENANT, client: db.client, settings: { globalLevel: 'masked_query' }, log: () => {} });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.query_masked).toBeNull();
    expect(db.inserts[0]!.query_fingerprint).toBeNull();
    expect(JSON.stringify(db.inserts[0])).not.toContain('second report');
  });

  it('keeps the masked query for an inheriting tenant under masked_query', async () => {
    const db = fakeDb(null);
    await writeRetrievalLog(maskedRow(), { expectedTenantKey: TENANT, client: db.client, settings: { globalLevel: 'masked_query' }, log: () => {} });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.query_masked).toBe(QUERY);
  });

  it('writes nothing when the settings read fails', async () => {
    const db = fakeDb('inherit');
    db.failRead = true;
    await writeRetrievalLog(maskedRow(), { expectedTenantKey: TENANT, client: db.client, settings: { globalLevel: 'masked_query', log: () => {} }, log: () => {} });
    expect(db.inserts).toHaveLength(0);
  });
});
