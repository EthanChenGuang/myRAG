import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const ADMIN_A = '00000000-0000-4000-8000-0000000025e1';
const ADMIN_B = '00000000-0000-4000-8000-0000000025e2';
const TENANT_A = `u:${ADMIN_A}`;
const TENANT_B = `u:${ADMIN_B}`;
const BASE = 'http://localhost/api/rag/admin/eval-run-requests';

interface State {
  guard: { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503 };
  rows: Row[];
  tenantKeys: Record<string, string[]>;
}

let state: State;
let seq = 0;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function seed(tenant: string, over: Row = {}): Row {
  seq += 1;
  const row: Row = {
    id: uuid(0x2500 + seq),
    tenant_key: tenant,
    reason: 'backfill_completed',
    ref_id: uuid(0x9000 + seq),
    status: 'pending',
    skip_reason: null,
    result_summary: null,
    requested_at: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 10, 1, 0, 0, seq)).toISOString(),
    ...over,
  };
  state.rows.push(row);
  return row;
}

function parseOr(expr: string): (row: Row) => boolean {
  const match = /^requested_at\.lt\."([^"]+)",and\(requested_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/.exec(expr);
  if (!match) throw new Error(`unsupported or filter ${expr}`);
  const [, at, eqAt, id] = match;
  return (row) => String(row.requested_at) < at || (row.requested_at === eqAt && String(row.id) < id);
}

function builder(table: string) {
  if (table !== 'rag_eval_run_requests') throw new Error(`unexpected table ${table}`);
  const filters: Array<(row: Row) => boolean> = [];
  const orders: Array<{ column: string; ascending: boolean }> = [];
  let limit = Infinity;
  let update: Row | null = null;
  const run = () => {
    let hit = state.rows.filter((row) => filters.every((filter) => filter(row)));
    if (update) {
      for (const row of hit) Object.assign(row, update);
      return { data: hit.map((row) => ({ ...row })), error: null };
    }
    hit = [...hit].sort((a, b) => {
      for (const { column, ascending } of orders) {
        const x = String(a[column]);
        const y = String(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    return { data: hit.slice(0, limit).map((row) => ({ ...row })), error: null };
  };
  const api = {
    select: () => api,
    update: (payload: Row) => {
      update = payload;
      return api;
    },
    eq: (column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return api;
    },
    in: (column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]));
      return api;
    },
    or: (expr: string) => {
      filters.push(parseOr(expr));
      return api;
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      orders.push({ column, ascending: options?.ascending ?? true });
      return api;
    },
    limit: (n: number) => {
      limit = n;
      return api;
    },
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  };
  return api;
}

const adminClient = {
  from: (table: string) => builder(table),
  rpc: async (fn: string, args: { p_actor: string }) => {
    if (fn !== 'rag_admin_tenant_keys') return { data: null, error: { message: 'unexpected' } };
    return { data: state.tenantKeys[args.p_actor] ?? [], error: null };
  },
};

async function routes() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/admin-route-auth')>();
    return { ...actual, checkAdmin: async () => (state.guard.ok ? { ok: true, userId: state.guard.userId } : { ok: false, status: state.guard.status, reason: 'denied' }) };
  });
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: adminClient, getSupabaseAdmin: () => adminClient, getSupabase: () => ({}) }));
  const list = await import('@/app/api/rag/admin/eval-run-requests/route');
  const one = await import('@/app/api/rag/admin/eval-run-requests/[id]/route');
  return { list, one };
}

function get(query = '') {
  return new NextRequest(`${BASE}${query}`, { method: 'GET' });
}

function post(body: unknown) {
  return new NextRequest(BASE, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

function patch(id: string, body: unknown) {
  return new NextRequest(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('eval run request routes (05.3-25, D-19, UI-SPEC 6.4)', () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    seq = 0;
    state = { guard: { ok: true, userId: ADMIN_A }, rows: [], tenantKeys: { [ADMIN_A]: [TENANT_A], [ADMIN_B]: [TENANT_B] } };
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
  });
  afterEach(() => {
    for (const spy of logs) spy.mockRestore();
    vi.doUnmock('@/lib/admin-route-auth');
    vi.doUnmock('@/lib/supabase');
  });

  it('GET lists only the admin tenant requests, newest first, at most 20, with a cursor to the rest', async () => {
    for (let i = 0; i < 23; i += 1) seed(TENANT_A);
    seed(TENANT_B);
    const { list } = await routes();
    const first = await list.GET(get());
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const page = await first.json();
    expect(page.requests).toHaveLength(20);
    expect(page.requests.every((row: Row) => row.tenant_key === TENANT_A)).toBe(true);
    const times = page.requests.map((row: Row) => String(row.requested_at));
    expect([...times].sort().reverse()).toEqual(times);
    expect(Object.keys(page.requests[0]).sort()).toEqual(
      ['checks', 'counts', 'id', 'reason', 'ref_id', 'requested_at', 'result', 'skip_reason', 'status', 'tenant_key', 'updated_at'].sort(),
    );
    expect(typeof page.next_cursor).toBe('string');
    const second = await (await list.GET(get(`?cursor=${page.next_cursor}`))).json();
    expect(second.requests).toHaveLength(3);
    expect(second.next_cursor).toBeNull();
    const ids = new Set([...page.requests, ...second.requests].map((row: Row) => row.id));
    expect(ids.size).toBe(23);
  });

  it('GET with a smaller limit pages, and a forged cursor is refused', async () => {
    for (let i = 0; i < 3; i += 1) seed(TENANT_A);
    const { list } = await routes();
    const page = await (await list.GET(get('?limit=2'))).json();
    expect(page.requests).toHaveLength(2);
    expect((await list.GET(get('?cursor=not-a-cursor'))).status).toBe(400);
    expect((await list.GET(get('?limit=21'))).status).toBe(400);
    expect((await list.GET(get('?tenant=u:x'))).status).toBe(400);
  });

  it('a denied caller gets the guard status and reads nothing', async () => {
    seed(TENANT_A);
    const { list, one } = await routes();
    state.guard = { ok: false, status: 401 };
    expect((await list.GET(get())).status).toBe(401);
    state.guard = { ok: false, status: 403 };
    expect((await list.POST(post({ action: 'claim' }))).status).toBe(403);
    expect((await one.PATCH(patch(String(state.rows[0].id), { status: 'done' }), ctx(String(state.rows[0].id)))).status).toBe(403);
    expect(state.rows[0].status).toBe('pending');
  });

  it('POST claim returns up to the limit as running, oldest first, and a second claim does not return them again', async () => {
    for (let i = 0; i < 7; i += 1) seed(TENANT_A);
    seed(TENANT_B);
    const { list } = await routes();
    const first = await (await list.POST(post({ action: 'claim', limit: 5 }))).json();
    expect(first.requests).toHaveLength(5);
    expect(first.requests.every((row: Row) => row.status === 'running' && row.tenant_key === TENANT_A)).toBe(true);
    const second = await (await list.POST(post({ action: 'claim', limit: 5 }))).json();
    expect(second.requests).toHaveLength(2);
    const overlap = second.requests.filter((row: Row) => first.requests.some((other: Row) => other.id === row.id));
    expect(overlap).toHaveLength(0);
    expect(state.rows.find((row) => row.tenant_key === TENANT_B)?.status).toBe('pending');
    expect((await list.POST(post({ action: 'drain' }))).status).toBe(400);
    expect((await list.POST(post({ action: 'claim', limit: 5, tenant_key: TENANT_B }))).status).toBe(400);
  });

  it('PATCH closes a running row as skipped with no_real_set; pending or closed rows answer 409', async () => {
    const running = seed(TENANT_A, { status: 'running' });
    const pending = seed(TENANT_A);
    const { one } = await routes();
    const closed = await one.PATCH(patch(String(running.id), { status: 'skipped', skip_reason: 'no_real_set' }), ctx(String(running.id)));
    expect(closed.status).toBe(200);
    expect((await closed.json()).request).toMatchObject({ status: 'skipped', skip_reason: 'no_real_set' });
    expect((await one.PATCH(patch(String(running.id), { status: 'done' }), ctx(String(running.id)))).status).toBe(409);
    expect((await one.PATCH(patch(String(pending.id), { status: 'done' }), ctx(String(pending.id)))).status).toBe(409);
    expect(pending.status).toBe('pending');
  });

  it('PATCH done stores a numbers-only summary and returns result and failed checks', async () => {
    const running = seed(TENANT_A, { status: 'running' });
    const { one, list } = await routes();
    const summary = { result: 'fail', failed_checks: ['refusal_rate', 'citation_precision'], counts: { items: 120, failed: 2 } };
    const response = await one.PATCH(patch(String(running.id), { status: 'done', result_summary: summary }), ctx(String(running.id)));
    expect(response.status).toBe(200);
    const listed = await (await list.GET(get())).json();
    expect(listed.requests[0]).toMatchObject({ status: 'done', result: 'fail', checks: ['refusal_rate', 'citation_precision'], counts: { items: 120, failed: 2 } });
  });

  it('PATCH refuses free text in the summary, a skip without a reason and an unknown field', async () => {
    const running = seed(TENANT_A, { status: 'running' });
    const { one } = await routes();
    const id = String(running.id);
    const bad = [
      { status: 'done', result_summary: { failed_checks: ['The answer cited a document that was deleted last week'] } },
      { status: 'done', result_summary: { result: 'pass', note: 'free text' } },
      { status: 'done', result_summary: { counts: { items: 'many' } } },
      { status: 'skipped' },
      { status: 'skipped', skip_reason: 'No real set for this tenant' },
      { status: 'done', skip_reason: 'no_real_set' },
      { status: 'pending' },
      { status: 'done', tenant_key: TENANT_B },
    ];
    for (const body of bad) expect((await one.PATCH(patch(id, body), ctx(id))).status, JSON.stringify(body)).toBe(400);
    expect(running.status).toBe('running');
  });

  it('PATCH on another tenant request answers 404 like an unknown id and changes nothing', async () => {
    const other = seed(TENANT_B, { status: 'running' });
    const { one } = await routes();
    expect((await one.PATCH(patch(String(other.id), { status: 'done' }), ctx(String(other.id)))).status).toBe(404);
    expect((await one.PATCH(patch(uuid(0xdead), { status: 'done' }), ctx(uuid(0xdead)))).status).toBe(404);
    expect((await one.PATCH(patch('not-a-uuid', { status: 'done' }), ctx('not-a-uuid'))).status).toBe(400);
    expect(other.status).toBe('running');
  });

  it('an admin with no tenants sees and claims nothing', async () => {
    seed(TENANT_A);
    state.tenantKeys[ADMIN_A] = [];
    const { list } = await routes();
    expect((await (await list.GET(get())).json()).requests).toEqual([]);
    expect((await (await list.POST(post({ action: 'claim' }))).json()).requests).toEqual([]);
    expect(state.rows[0].status).toBe('pending');
  });
});
