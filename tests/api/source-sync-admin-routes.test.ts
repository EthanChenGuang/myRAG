import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const OWNER_ID = '00000000-0000-4000-8000-0000000000b1';
const MEMBER_ID = '00000000-0000-4000-8000-0000000000b2';
const RUN_ID = '00000000-0000-4000-8000-0000000000c1';
const CONN_ID = '00000000-0000-4000-8000-0000000000d1';
const CONN_TWO = '00000000-0000-4000-8000-0000000000d2';
const CONN_THREE = '00000000-0000-4000-8000-0000000000d3';
const CONN_ONE_OK = '00000000-0000-4000-8000-0000000000d4';
const NANGO_CONN = 'nango-conn-1';
const FILE_NAME = 'synthetic-note-01.md';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | Row | null; error: { code?: string; message: string } | null };

const state = {
  admins: [] as string[],
  session: null as { id: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
  tables: {} as Record<string, Row[]>,
  tableReads: [] as string[],
  users: {} as Record<string, string>,
  applyCalls: [] as Array<{ connection: Row; ids: string[]; origin: string }>,
  applyResult: { removed: 0, failed: 0, deferred: 0 },
};

function tableBuilder(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  let limit: number | null = null;
  const rows = () => {
    state.tableReads.push(table);
    let out = (state.tables[table] ?? []).filter(
      (row) => eqs.every(([c, v]) => row[c] === v) && ins.every(([c, vs]) => vs.includes(row[c])),
    );
    if (limit !== null) out = out.slice(0, limit);
    return out;
  };
  const builder = {
    select: () => builder,
    abortSignal: () => builder,
    order: () => builder,
    eq(column: string, value: unknown) {
      eqs.push([column, value]);
      return builder;
    },
    in(column: string, values: unknown[]) {
      ins.push([column, values]);
      return builder;
    },
    limit(n: number) {
      limit = n;
      return builder;
    },
    maybeSingle() {
      if (table === 'admin_users') {
        const id = eqs.find(([c]) => c === 'id')?.[1] as string;
        return Promise.resolve({ data: state.admins.includes(id) ? { id } : null, error: null });
      }
      return Promise.resolve({ data: rows()[0] ?? null, error: null });
    },
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(onFulfilled, onRejected),
  };
  return builder;
}

function fakeAdmin() {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }),
      admin: {
        getUserById: async (id: string) => ({ data: { user: state.users[id] ? { id, email: state.users[id] } : null }, error: null }),
      },
    },
    from: (table: string) => tableBuilder(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const outcome = state.outcomes[fn] ?? { data: [], error: null };
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeAdmin(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/nango/source-deletions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/nango/source-deletions')>()),
    applySourceDeletions: async (connection: Row, ids: string[], origin: string) => {
      state.applyCalls.push({ connection, ids: [...ids], origin });
      return { ...state.applyResult };
    },
  }));
  const confirm = await import('@/app/api/rag/admin/source-sync/runs/[id]/confirm/route');
  const dismiss = await import('@/app/api/rag/admin/source-sync/runs/[id]/dismiss/route');
  const mode = await import('@/app/api/rag/admin/source-sync/connections/[id]/deletion-mode/route');
  const list = await import('@/app/api/rag/admin/source-sync/connections/route');
  return { confirm, dismiss, mode, list };
}

function req(url: string, init: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(body !== undefined ? { body } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const confirmReq = (id = RUN_ID, init: Parameters<typeof req>[1] = {}) =>
  req(`/api/rag/admin/source-sync/runs/${id}/confirm`, { method: 'POST', ...init });
const dismissReq = (id = RUN_ID) => req(`/api/rag/admin/source-sync/runs/${id}/dismiss`, { method: 'POST' });
const modeReq = (id: string, body: unknown) => req(`/api/rag/admin/source-sync/connections/${id}/deletion-mode`, { method: 'PUT', body });

const sqlError = (message: string) => ({ data: null, error: { code: 'P0001', message } });

function decided(status: string, candidates: string[]): RpcOutcome {
  return {
    data: [{ run_id: RUN_ID, connection_id: CONN_ID, owner_user_id: OWNER_ID, tenant_key: `u:${OWNER_ID}`, status, candidate_file_ids: candidates }],
    error: null,
  };
}

const CONNECTION_ROW = {
  id: CONN_ID,
  connection_id: NANGO_CONN,
  user_id: OWNER_ID,
  provider: 'dropbox',
  deletion_mode: 'soft',
  status: 'connected',
};

let logged: string[];

beforeEach(() => {
  state.admins = [ADMIN_ID, OTHER_ADMIN_ID];
  state.session = null;
  state.rpcCalls = [];
  state.outcomes = {};
  state.tables = { nango_connections: [{ ...CONNECTION_ROW }], rag_source_reconcile_runs: [], nango_sync_records: [] };
  state.tableReads = [];
  state.users = {};
  state.applyCalls = [];
  state.applyResult = { removed: 0, failed: 0, deferred: 0 };
  logged = [];
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  for (const method of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('source sync admin routes: guard', () => {
  it('answers 401 without a session and 403 to a signed-in non-admin, and runs no function', async () => {
    const loaded = await load();
    const calls = [
      () => loaded.confirm.POST(confirmReq(), params(RUN_ID)),
      () => loaded.dismiss.POST(dismissReq(), params(RUN_ID)),
      () => loaded.mode.PUT(modeReq(CONN_ID, { mode: 'soft' }), params(CONN_ID)),
      () => loaded.list.GET(req('/api/rag/admin/source-sync/connections')),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
    for (const user of [OWNER_ID, MEMBER_ID]) {
      state.session = { id: user };
      for (const call of calls) expect((await call()).status).toBe(403);
    }
    expect(state.rpcCalls).toEqual([]);
    expect(state.applyCalls).toEqual([]);
  });
});

describe('POST /api/rag/admin/source-sync/runs/{id}/confirm', () => {
  it('confirms a paused run within the window: the verified admin decides, the candidates are removed in the connection mode with origin admin, the counts are stored', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = decided('confirmed', ['f1', 'f2', 'f3']);
    state.applyResult = { removed: 2, failed: 1, deferred: 0 };
    const response = await loaded.confirm.POST(confirmReq(RUN_ID, { headers: { 'x-actor-id': OTHER_ADMIN_ID } }), params(RUN_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, removed: 2, failed: 1 });
    expect(state.rpcCalls[0]).toEqual({ fn: 'rag_source_reconcile_run_decide', args: { p_actor: ADMIN_ID, p_run_id: RUN_ID, p_decision: 'confirm' } });
    expect(state.applyCalls).toHaveLength(1);
    expect(state.applyCalls[0].ids).toEqual(['f1', 'f2', 'f3']);
    expect(state.applyCalls[0].origin).toBe('admin');
    expect(state.applyCalls[0].connection).toMatchObject({ id: CONN_ID, connection_id: NANGO_CONN, user_id: OWNER_ID, deletion_mode: 'soft' });
    expect(state.rpcCalls[1]).toEqual({ fn: 'rag_source_reconcile_run_finish', args: { p_run_id: RUN_ID, p_removed: 2, p_failed: 1 } });
    expect(logged.some((line) => line.includes('[RAG Admin]') && line.includes(RUN_ID))).toBe(true);
  });

  it('removes candidates beyond one deletion batch in further batches', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const ids = Array.from({ length: 120 }, (_, index) => `file-${index}`);
    state.outcomes.rag_source_reconcile_run_decide = decided('confirmed', ids);
    state.applyResult = { removed: 1, failed: 0, deferred: 0 };
    const response = await loaded.confirm.POST(confirmReq(), params(RUN_ID));
    expect(response.status).toBe(200);
    expect(state.applyCalls.map((call) => call.ids.length)).toEqual([50, 50, 20]);
    expect(state.applyCalls.flatMap((call) => call.ids)).toEqual(ids);
    expect(await response.json()).toEqual({ success: true, removed: 3, failed: 0 });
  });

  it('answers 409 confirmation_expired after 24 hours and removes nothing', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = sqlError('confirmation_expired');
    const response = await loaded.confirm.POST(confirmReq(), params(RUN_ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'confirmation_expired' });
    expect(state.applyCalls).toEqual([]);
    expect(state.rpcCalls.map((call) => call.fn)).toEqual(['rag_source_reconcile_run_decide']);
  });

  it('answers 409 run_not_pending for a run that is not awaiting confirmation', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = sqlError('run_not_pending');
    const response = await loaded.confirm.POST(confirmReq(), params(RUN_ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'run_not_pending' });
    expect(state.applyCalls).toEqual([]);
  });

  it('answers the same 404 body for an unknown and another tenant run id', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = sqlError('not_found');
    const first = await loaded.confirm.POST(confirmReq(), params(RUN_ID));
    const other = '00000000-0000-4000-8000-0000000000c9';
    const second = await loaded.confirm.POST(confirmReq(other), params(other));
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await first.json()).toEqual(await second.json());
    expect(state.applyCalls).toEqual([]);
  });

  it('answers 400 for a non-uuid id and for an actor in the body, before any function runs', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await loaded.confirm.POST(confirmReq('not-a-uuid'), params('not-a-uuid'))).status).toBe(400);
    expect((await loaded.confirm.POST(confirmReq(RUN_ID, { body: { actor: OTHER_ADMIN_ID } }), params(RUN_ID))).status).toBe(400);
    expect((await loaded.confirm.POST(confirmReq(RUN_ID, { raw: '{not json' }), params(RUN_ID))).status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 503 and removes nothing when the connection row of a confirmed run cannot be read', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.tables.nango_connections = [];
    state.outcomes.rag_source_reconcile_run_decide = decided('confirmed', ['f1']);
    const response = await loaded.confirm.POST(confirmReq(), params(RUN_ID));
    expect(response.status).toBe(503);
    expect(state.applyCalls).toEqual([]);
  });

  it('maps an unknown database error to 503 without echoing it', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = sqlError('connection reset by peer');
    const response = await loaded.confirm.POST(confirmReq(), params(RUN_ID));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('connection reset');
  });
});

describe('POST /api/rag/admin/source-sync/runs/{id}/dismiss', () => {
  it('dismisses a run: 200, nothing removed, the verified admin is the actor', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = decided('dismissed', []);
    const response = await loaded.dismiss.POST(dismissReq(), params(RUN_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, status: 'dismissed' });
    expect(state.rpcCalls).toEqual([{ fn: 'rag_source_reconcile_run_decide', args: { p_actor: ADMIN_ID, p_run_id: RUN_ID, p_decision: 'dismiss' } }]);
    expect(state.applyCalls).toEqual([]);
  });

  it('answers 404 for an unknown run and 409 for one that is not pending', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_reconcile_run_decide = sqlError('not_found');
    expect((await loaded.dismiss.POST(dismissReq(), params(RUN_ID))).status).toBe(404);
    state.outcomes.rag_source_reconcile_run_decide = sqlError('run_not_pending');
    expect((await loaded.dismiss.POST(dismissReq(), params(RUN_ID))).status).toBe(409);
  });
});

describe('PUT /api/rag/admin/source-sync/connections/{id}/deletion-mode', () => {
  it('sets purge, soft and the default (null) through the SQL function with the verified admin', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const mode of ['purge', 'soft', null]) {
      state.outcomes.rag_source_sync_set_deletion_mode = { data: [{ connection_id: CONN_ID, deletion_mode: mode }], error: null };
      const response = await loaded.mode.PUT(modeReq(CONN_ID, { mode }), params(CONN_ID));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, id: CONN_ID, deletion_mode: mode });
    }
    expect(state.rpcCalls.map((call) => call.args)).toEqual([
      { p_actor: ADMIN_ID, p_connection_id: CONN_ID, p_mode: 'purge' },
      { p_actor: ADMIN_ID, p_connection_id: CONN_ID, p_mode: 'soft' },
      { p_actor: ADMIN_ID, p_connection_id: CONN_ID, p_mode: null },
    ]);
    expect(state.applyCalls).toEqual([]);
  });

  it('answers 400 for an unknown mode, an extra key, a missing mode and a non-uuid id', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const body of [{ mode: 'hard' }, { mode: 'soft', actor: OTHER_ADMIN_ID }, {}, 'soft']) {
      expect((await loaded.mode.PUT(modeReq(CONN_ID, body), params(CONN_ID))).status).toBe(400);
    }
    expect((await loaded.mode.PUT(modeReq('x', { mode: 'soft' }), params('x'))).status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 404 for another tenant connection', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_sync_set_deletion_mode = sqlError('not_found');
    const response = await loaded.mode.PUT(modeReq(CONN_TWO, { mode: 'purge' }), params(CONN_TWO));
    expect(response.status).toBe(404);
    expect((await response.json()).success).toBe(false);
  });
});

const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function listRow(overrides: Row): Row {
  return {
    connection_id: CONN_ID,
    provider: 'dropbox',
    owner_user_id: OWNER_ID,
    tenant_key: `u:${OWNER_ID}`,
    status: 'connected',
    connected_at: daysAgo(40),
    last_full_reconcile_at: daysAgo(1),
    last_reconcile_status: 'ok',
    deletion_mode: null,
    document_count: 3,
    awaiting_run_id: null,
    awaiting_created_at: null,
    awaiting_expires_at: null,
    awaiting_candidate_count: null,
    awaiting_total_count: null,
    total_rows: 3,
    ...overrides,
  };
}

describe('GET /api/rag/admin/source-sync/connections', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the admin tenant connections with state, paused run, file names and limits, paused first then overdue', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.users = { [OWNER_ID]: 'owner@example.test' };
    const candidates = Array.from({ length: 25 }, (_, index) => `file-${index}`);
    state.outcomes.rag_source_sync_admin_connections = {
      data: [
        listRow({ connection_id: CONN_ONE_OK, provider: 'google-drive' }),
        listRow({ connection_id: CONN_TWO, provider: 'notion', last_full_reconcile_at: daysAgo(12) }),
        listRow({
          connection_id: CONN_THREE,
          provider: 'dropbox',
          deletion_mode: 'purge',
          last_reconcile_status: 'paused',
          awaiting_run_id: RUN_ID,
          awaiting_created_at: daysAgo(0.5),
          awaiting_expires_at: new Date(NOW + 12 * 3_600_000).toISOString(),
          awaiting_candidate_count: 25,
          awaiting_total_count: 40,
        }),
      ],
      error: null,
    };
    state.tables.rag_source_reconcile_runs = [
      { id: 'r-1', connection_id: CONN_ONE_OK, origin: 'scheduled', status: 'completed', error_code: null, created_at: daysAgo(1), expires_at: null, candidate_file_ids: [] },
      { id: 'r-2', connection_id: CONN_TWO, origin: 'scheduled', status: 'completed', error_code: null, created_at: daysAgo(12), expires_at: null, candidate_file_ids: [] },
      {
        id: RUN_ID,
        connection_id: CONN_THREE,
        origin: 'scheduled',
        status: 'awaiting_confirmation',
        error_code: null,
        created_at: daysAgo(0.5),
        expires_at: new Date(NOW + 12 * 3_600_000).toISOString(),
        candidate_file_ids: candidates,
      },
    ];
    state.tables.nango_connections = [{ id: CONN_THREE, connection_id: 'nango-three', user_id: OWNER_ID, provider: 'dropbox' }];
    state.tables.nango_sync_records = candidates.map((fileId, index) => ({
      connection_id: 'nango-three',
      user_id: OWNER_ID,
      file_id: fileId,
      file_name: index === 0 ? FILE_NAME : `synthetic-${index}.md`,
      content: 'never returned',
    }));

    const response = await loaded.list.GET(req('/api/rag/admin/source-sync/connections?limit=20&offset=0'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(state.rpcCalls).toEqual([{ fn: 'rag_source_sync_admin_connections', args: { p_actor: ADMIN_ID, p_limit: 20, p_offset: 0 } }]);
    expect(body).toMatchObject({ success: true, total: 3, limit: 20, offset: 0, limits: { max_age_days: 7, max_delete_share: 0.3 } });
    expect(body.items.map((item: Row) => item.id)).toEqual([CONN_THREE, CONN_TWO, CONN_ONE_OK]);
    const [paused, overdue, ok] = body.items;
    expect(paused).toMatchObject({
      provider: 'dropbox',
      provider_name: 'Dropbox',
      owner: { id: OWNER_ID, label: 'owner@example.test' },
      workspace_key: `u:${OWNER_ID}`,
      document_count: 3,
      deletion_mode: 'purge',
      states: ['paused'],
    });
    expect(paused.paused_run).toMatchObject({ id: RUN_ID, candidate_count: 25, total_count: 40, names_not_sent: 5 });
    expect(paused.paused_run.file_names).toHaveLength(20);
    expect(paused.paused_run.file_names[0]).toBe(FILE_NAME);
    expect(overdue).toMatchObject({ provider_name: 'Notion', states: ['overdue'], days_without_reconcile: 12, paused_run: null });
    expect(ok).toMatchObject({ provider_name: 'Google Drive', states: ['in_step'], days_without_reconcile: 1, paused_run: null });
    expect(JSON.stringify(body)).not.toContain('never returned');
    expect(logged.join('\n')).not.toContain(FILE_NAME);
    expect(logged.join('\n')).not.toContain('owner@example.test');
  });

  it('returns every open paused run as paused_runs with its pause_reason, the cap and the limit (D-49)', async () => {
    vi.stubEnv('RAG_SOURCE_PURGE_DAILY_CAP', '3');
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const CAP_RUN = '00000000-0000-4000-8000-0000000000c2';
    const EXPIRED_RUN = '00000000-0000-4000-8000-0000000000c3';
    const future = new Date(NOW + 12 * 3_600_000).toISOString();
    state.outcomes.rag_source_sync_admin_connections = {
      data: [
        listRow({
          connection_id: CONN_THREE,
          deletion_mode: 'purge',
          last_reconcile_status: 'paused',
          awaiting_run_id: CAP_RUN,
          awaiting_created_at: daysAgo(0.1),
          awaiting_expires_at: future,
          awaiting_candidate_count: 2,
          awaiting_total_count: null,
        }),
      ],
      error: null,
    };
    const tenant = `u:${OWNER_ID}`;
    state.tables.rag_source_reconcile_runs = [
      { id: RUN_ID, connection_id: CONN_THREE, tenant_key: tenant, origin: 'scheduled', status: 'awaiting_confirmation', error_code: null, created_at: daysAgo(0.5), expires_at: future, candidate_count: 6, total_count: 10, candidate_file_ids: ['s-1'], pause_reason: null, daily_cap: null },
      { id: CAP_RUN, connection_id: CONN_THREE, tenant_key: tenant, origin: 'change_feed', status: 'awaiting_confirmation', error_code: null, created_at: daysAgo(0.1), expires_at: future, candidate_count: 2, total_count: null, candidate_file_ids: ['c-1', 'c-2'], pause_reason: 'purge_daily_cap', daily_cap: 3 },
      { id: EXPIRED_RUN, connection_id: CONN_THREE, tenant_key: tenant, origin: 'change_feed', status: 'awaiting_confirmation', error_code: null, created_at: daysAgo(2), expires_at: daysAgo(1), candidate_count: 1, total_count: null, candidate_file_ids: ['x-1'], pause_reason: 'purge_daily_cap', daily_cap: 3 },
    ];
    state.tables.nango_connections = [{ id: CONN_THREE, connection_id: 'nango-three', user_id: OWNER_ID, provider: 'dropbox' }];
    state.tables.nango_sync_records = [{ connection_id: 'nango-three', user_id: OWNER_ID, file_id: 's-1', file_name: FILE_NAME }];

    const response = await loaded.list.GET(req('/api/rag/admin/source-sync/connections'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.limits).toEqual({ max_age_days: 7, max_delete_share: 0.3, purge_daily_cap: 3 });
    const [item] = body.items;
    expect(item.paused_runs.map((run: Row) => run.id)).toEqual([CAP_RUN, RUN_ID]);
    expect(item.paused_runs[0]).toEqual({
      id: CAP_RUN,
      found_at: daysAgo(0.1),
      expires_at: future,
      candidate_count: 2,
      total_count: null,
      file_names: [],
      names_not_sent: 2,
      pause_reason: 'purge_daily_cap',
      daily_cap: 3,
      file_ids: ['c-1', 'c-2'],
    });
    expect(item.paused_runs[1]).toMatchObject({ id: RUN_ID, pause_reason: 'share', candidate_count: 6, total_count: 10, file_names: [FILE_NAME], names_not_sent: 5 });
    expect(item.paused_runs[1]).not.toHaveProperty('daily_cap');
    expect(item.paused_runs[1]).not.toHaveProperty('file_ids');
    expect(item.paused_run).toEqual(item.paused_runs[0]);
  });

  it('a share pause alone keeps the paused_run fields and adds pause_reason share; the cap limit is 0 by default', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_sync_admin_connections = {
      data: [listRow({ connection_id: CONN_THREE, awaiting_run_id: RUN_ID, awaiting_created_at: daysAgo(0.5), awaiting_expires_at: new Date(NOW + 3_600_000).toISOString(), awaiting_candidate_count: 6, awaiting_total_count: 10 })],
      error: null,
    };
    const response = await loaded.list.GET(req('/api/rag/admin/source-sync/connections'));
    const body = await response.json();
    expect(body.limits.purge_daily_cap).toBe(0);
    expect(Object.keys(body.items[0].paused_run).sort()).toEqual(
      ['candidate_count', 'expires_at', 'file_names', 'found_at', 'id', 'names_not_sent', 'pause_reason', 'total_count'],
    );
    expect(body.items[0].paused_run.pause_reason).toBe('share');
    expect(body.items[0].paused_runs).toHaveLength(1);
  });

  it('lists only what the SQL function returns for the verified admin (another user personal connection is not listed)', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_sync_admin_connections = { data: [], error: null };
    state.tables.nango_connections = [{ id: CONN_TWO, connection_id: 'nango-other', user_id: MEMBER_ID, provider: 'notion' }];
    const response = await loaded.list.GET(req('/api/rag/admin/source-sync/connections', { headers: { 'x-actor-id': OTHER_ADMIN_ID } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(state.rpcCalls[0].args).toEqual({ p_actor: ADMIN_ID, p_limit: 50, p_offset: 0 });
  });

  it('answers 400 for a page outside the limits before any function runs', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc', 'cursor=x']) {
      expect((await loaded.list.GET(req(`/api/rag/admin/source-sync/connections?${query}`))).status, query).toBe(400);
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 503 when the SQL function fails', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_source_sync_admin_connections = sqlError('boom');
    expect((await loaded.list.GET(req('/api/rag/admin/source-sync/connections'))).status).toBe(503);
  });
});

