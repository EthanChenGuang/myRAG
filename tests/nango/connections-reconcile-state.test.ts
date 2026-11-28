import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const C_OK = '00000000-0000-4000-8000-0000000000c1';
const C_PAUSED = '00000000-0000-4000-8000-0000000000c2';
const C_BOTH = '00000000-0000-4000-8000-0000000000c3';
const C_OVERDUE = '00000000-0000-4000-8000-0000000000c4';
const C_NEVER = '00000000-0000-4000-8000-0000000000c5';

const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

type Row = Record<string, unknown>;

const state = {
  connections: [] as Row[],
  runs: [] as Row[],
  runsFail: false,
};

function builderFor(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const run = () => {
    if (table === 'rag_source_reconcile_runs' && state.runsFail) return { data: null, error: { code: '57014', message: 'timeout' } };
    const rows = table === 'nango_connections' ? state.connections : table === 'rag_source_reconcile_runs' ? state.runs : [];
    return {
      data: rows.filter((row) => eqs.every(([c, v]) => row[c] === v) && ins.every(([c, vs]) => vs.includes(row[c]))).map((row) => ({ ...row })),
      error: null,
    };
  };
  const builder = {
    select: () => builder,
    order: () => builder,
    eq(column: string, value: unknown) {
      eqs.push([column, value]);
      return builder;
    },
    in(column: string, values: unknown[]) {
      ins.push([column, values]);
      return builder;
    },
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled, onRejected),
  };
  return builder;
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/nango/client', () => ({
    isNangoEnabled: () => true,
    getNango: () => ({
      listConnections: async () => ({ connections: state.connections.map((row) => ({ connection_id: row.connection_id, end_user: { id: USER_A } })) }),
    }),
  }));
  vi.doMock('@/lib/nango/sync-manager', () => ({ syncDocumentsForConnection: vi.fn() }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: USER_A } }, error: null }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: (table: string) => builderFor(table) }) }));
  return import('@/app/api/nango/connections/route');
}

function connection(id: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: USER_A,
    provider: 'dropbox',
    connection_id: `nango-${id.slice(-2)}`,
    status: 'connected',
    connected_at: daysAgo(40),
    last_synced_at: daysAgo(1),
    last_full_reconcile_at: daysAgo(1),
    last_reconcile_status: 'ok',
    deletion_mode: null,
    created_at: daysAgo(40),
    ...overrides,
  };
}

const scheduled = (connectionId: string, status: string, created: string, extra: Row = {}): Row => ({
  id: `${connectionId}-${status}`,
  connection_id: connectionId,
  origin: 'scheduled',
  status,
  error_code: null,
  created_at: created,
  expires_at: null,
  ...extra,
});

async function stateOf(): Promise<Record<string, unknown>> {
  const route = await load();
  const response = await route.GET(new NextRequest('http://localhost/api/nango/connections', { headers: { authorization: 'Bearer x' } }));
  expect(response.status).toBe(200);
  const body = await response.json();
  return Object.fromEntries((body.connections as Row[]).map((row) => [row.id as string, row.reconcile_state]));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.connections = [];
  state.runs = [];
  state.runsFail = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('GET /api/nango/connections reconcile_state (D-26)', () => {
  it('is ok for a connection with a recent completed scheduled run', async () => {
    state.connections = [connection(C_OK)];
    state.runs = [scheduled(C_OK, 'completed', daysAgo(1))];
    expect(await stateOf()).toEqual({ [C_OK]: 'ok' });
  });

  it('is paused for a connection with an open paused run', async () => {
    state.connections = [connection(C_PAUSED, { last_reconcile_status: 'paused' })];
    state.runs = [scheduled(C_PAUSED, 'awaiting_confirmation', daysAgo(0.2), { expires_at: inHours(20) })];
    expect(await stateOf()).toEqual({ [C_PAUSED]: 'paused' });
  });

  it('is paused, not overdue, for a connection that is paused and overdue', async () => {
    state.connections = [connection(C_BOTH, { last_full_reconcile_at: daysAgo(20), last_reconcile_status: 'paused' })];
    state.runs = [
      scheduled(C_BOTH, 'completed', daysAgo(20)),
      scheduled(C_BOTH, 'awaiting_confirmation', daysAgo(0.2), { expires_at: inHours(20) }),
    ];
    expect(await stateOf()).toEqual({ [C_BOTH]: 'paused' });
  });

  it('is overdue for a connection a scheduled run attempted and that has gone past the age limit', async () => {
    state.connections = [connection(C_OVERDUE, { last_full_reconcile_at: daysAgo(12) })];
    state.runs = [scheduled(C_OVERDUE, 'completed', daysAgo(12)), scheduled(C_OVERDUE, 'incomplete', daysAgo(1))];
    expect(await stateOf()).toEqual({ [C_OVERDUE]: 'overdue' });
  });

  it('is ok for an old connection that no scheduled run has attempted yet (D-39)', async () => {
    state.connections = [connection(C_NEVER, { last_full_reconcile_at: null, last_reconcile_status: null })];
    state.runs = [];
    expect(await stateOf()).toEqual({ [C_NEVER]: 'ok' });
  });

  it('leaves every other field identical to before', async () => {
    const row = connection(C_OK);
    state.connections = [row];
    state.runs = [scheduled(C_OK, 'completed', daysAgo(1))];
    const route = await load();
    const body = await (await route.GET(new NextRequest('http://localhost/api/nango/connections'))).json();
    expect(body).toEqual({ enabled: true, connections: [{ ...row, is_valid: true, reconcile_state: 'ok' }] });
  });

  it('leaves the field out, and the rest unchanged, when the runs cannot be read', async () => {
    const row = connection(C_PAUSED, { last_reconcile_status: 'paused' });
    state.connections = [row];
    state.runsFail = true;
    const route = await load();
    const body = await (await route.GET(new NextRequest('http://localhost/api/nango/connections'))).json();
    expect(body).toEqual({ enabled: true, connections: [{ ...row, is_valid: true }] });
  });
});
