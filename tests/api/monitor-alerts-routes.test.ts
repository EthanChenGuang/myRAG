import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorAlertSchema } from '@/lib/rag-eval/contracts.generated';

type Row = Record<string, unknown>;

const ADMIN_A = '00000000-0000-4000-8000-0000000029a1';
const ADMIN_B = '00000000-0000-4000-8000-0000000029b1';
const TENANT_A = `u:${ADMIN_A}`;
const TENANT_B = `u:${ADMIN_B}`;
const BASE = 'http://localhost/api/rag/admin/monitor/alerts';

interface State {
  guard: { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503 };
  alerts: Row[];
  runs: Row[];
  tenantKeys: Record<string, string[]>;
  queries: string[];
  setStatusCalls: Array<{ p_id: string; p_status: string; p_actor: string | null }>;
}

let state: State;
let seq = 0;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function day(offset: number): string {
  return new Date(Date.UTC(2026, 10, 25) - offset * 86_400_000).toISOString().slice(0, 10);
}

function seedAlert(tenant: string, over: Row = {}): Row {
  seq += 1;
  const row: Row = {
    id: uuid(0x2900 + seq),
    tenant_key: tenant,
    rule: 'refusal_rate',
    kind: 'rate',
    language: 'it',
    day: day(0),
    window_days: 1,
    severity: 'alert',
    status: 'open',
    observed_count: 76,
    observed_total: 200,
    baseline_count: 720,
    baseline_total: 6000,
    observed_rate: 0.38,
    baseline_rate: 0.12,
    band: { ratio: 2, min_abs_delta: 0.05, measured_ratio: 3.17, measured_delta: 0.26 },
    breakdown: { by_channel: { chat: { count: 70, n: 180, value: 0.389 } } },
    companions: { not_helpful_rate: { value: 0.1, baseline: 0.09, n: 200 } },
    sample_trace_ids: ['trace-a1', 'trace-a2'],
    config_changes: [],
    suggestion: 'recalibrate_refusal',
    delivered: { webhook: { state: 'pending', attempts: 0, last_attempt_at: null } },
    dedup_key: `refusal_rate|it|${seq}`,
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    created_at: '2026-11-25T02:10:00.000Z',
    updated_at: '2026-11-25T02:10:00.000Z',
    ...over,
  };
  state.alerts.push(row);
  return row;
}

function parseOr(expr: string): (row: Row) => boolean {
  const match = /^day\.lt\.(\d{4}-\d{2}-\d{2}),and\(day\.eq\.(\d{4}-\d{2}-\d{2}),id\.lt\.([0-9a-f-]+)\)$/.exec(expr);
  if (!match) throw new Error(`unsupported or filter ${expr}`);
  const [, lt, eq, id] = match;
  return (row) => String(row.day) < lt || (row.day === eq && String(row.id) < id);
}

function rowsOf(table: string): Row[] {
  if (table === 'rag_monitor_alerts') return state.alerts;
  if (table === 'rag_monitor_runs') return state.runs;
  throw new Error(`unexpected table ${table}`);
}

function builder(table: string) {
  const rows = rowsOf(table);
  const filters: Array<(row: Row) => boolean> = [];
  const orders: Array<{ column: string; ascending: boolean }> = [];
  let limit = Infinity;
  let columns = '*';
  let head = false;
  let counted = false;
  const run = () => {
    state.queries.push(table);
    let hit = rows.filter((row) => filters.every((filter) => filter(row)));
    if (head) return { data: null, count: counted ? hit.length : null, error: null };
    hit = [...hit].sort((a, b) => {
      for (const { column, ascending } of orders) {
        const x = String(a[column]);
        const y = String(b[column]);
        if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      }
      return 0;
    });
    const picked = columns === '*' ? null : columns.split(',').map((column) => column.trim());
    const data = hit.slice(0, limit).map((row) => (picked ? Object.fromEntries(picked.map((column) => [column, row[column]])) : { ...row }));
    return { data, count: counted ? hit.length : null, error: null };
  };
  const api = {
    select: (cols = '*', options?: { count?: string; head?: boolean }) => {
      columns = cols;
      head = options?.head === true;
      counted = options?.count === 'exact';
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
  rpc: async (fn: string, args: Record<string, unknown>) => {
    state.queries.push(fn);
    if (fn === 'rag_admin_tenant_keys') return { data: state.tenantKeys[String(args.p_actor)] ?? [], error: null };
    if (fn === 'rag_monitor_alert_set_status') {
      const call = args as { p_id: string; p_status: string; p_actor: string | null };
      state.setStatusCalls.push(call);
      const row = state.alerts.find((alert) => alert.id === call.p_id);
      if (!row) return { data: false, error: null };
      if (call.p_status === 'acknowledged' && row.status === 'open') {
        Object.assign(row, { status: 'acknowledged', acknowledged_at: '2026-11-25T14:02:00.000Z', acknowledged_by: call.p_actor });
        return { data: true, error: null };
      }
      if (call.p_status === 'resolved' && (row.status === 'open' || row.status === 'acknowledged')) {
        Object.assign(row, { status: 'resolved', resolved_at: '2026-11-25T14:03:00.000Z', resolved_by: call.p_actor });
        return { data: true, error: null };
      }
      return { data: false, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc' } };
  },
};

async function routes() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/admin-route-auth')>();
    return {
      ...actual,
      checkAdmin: async () => (state.guard.ok ? { ok: true, userId: state.guard.userId } : { ok: false, status: state.guard.status, reason: 'denied' }),
    };
  });
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: adminClient, getSupabaseAdmin: () => adminClient, getSupabase: () => ({}) }));
  const list = await import('@/app/api/rag/admin/monitor/alerts/route');
  const action = await import('@/app/api/rag/admin/monitor/alerts/[id]/[action]/route');
  return { list, action };
}

function get(query = '') {
  return new NextRequest(`${BASE}${query}`, { method: 'GET' });
}

function post(id: string, verb: string) {
  return new NextRequest(`${BASE}/${id}/${verb}`, { method: 'POST' });
}

const ctx = (id: string, verb: string) => ({ params: Promise.resolve({ id, action: verb }) });

const ENV_NAMES = ['RAG_MONITOR', 'RAG_RETRIEVAL_LOG'] as const;
let savedEnv: Record<string, string | undefined>;

describe('monitor alert routes (05.3-29, D-22, D-25, D-26, UI-SPEC 6.6, 6.7, 8.1)', () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    seq = 0;
    savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
    process.env.RAG_MONITOR = 'true';
    process.env.RAG_RETRIEVAL_LOG = 'ids';
    state = {
      guard: { ok: true, userId: ADMIN_A },
      alerts: [],
      runs: [],
      tenantKeys: { [ADMIN_A]: [TENANT_A], [ADMIN_B]: [TENANT_B] },
      queries: [],
      setStatusCalls: [],
    };
    logs = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const spy of logs) spy.mockRestore();
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    vi.doUnmock('@/lib/admin-route-auth');
    vi.doUnmock('@/lib/supabase');
  });

  describe('GET /api/rag/admin/monitor/alerts', () => {
    it('answers 404 with RAG_MONITOR off and runs no query, even for a denied caller', async () => {
      seedAlert(TENANT_A);
      process.env.RAG_MONITOR = 'false';
      const { list } = await routes();
      expect((await list.GET(get())).status).toBe(404);
      state.guard = { ok: false, status: 401 };
      expect((await list.GET(get())).status).toBe(404);
      expect(state.queries).toEqual([]);
    });

    it('a denied caller gets the guard status and reads nothing', async () => {
      seedAlert(TENANT_A);
      state.guard = { ok: false, status: 403 };
      const { list } = await routes();
      expect((await list.GET(get())).status).toBe(403);
      expect(state.queries).toEqual([]);
    });

    it('lists only the alerts of the tenants the admin administers, and every alert validates against MonitorAlertSchema', async () => {
      seedAlert(TENANT_A);
      seedAlert(TENANT_A, { status: 'acknowledged', acknowledged_at: '2026-11-25T03:00:00.000Z' });
      seedAlert(TENANT_B);
      seedAlert(TENANT_B, { status: 'acknowledged' });
      const { list } = await routes();
      const response = await list.GET(get());
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body.alerts).toHaveLength(2);
      expect(body.alerts.every((alert: Row) => alert.tenant_key === TENANT_A)).toBe(true);
      for (const alert of body.alerts) expect(MonitorAlertSchema.strict().safeParse(alert).success).toBe(true);
      expect(body.counts).toEqual({ open: 1, acknowledged: 1 });
      expect(body.next_cursor).toBeNull();
      const first = body.alerts.find((alert: Row) => alert.status === 'open');
      expect(first.observed).toEqual({ count: 76, n: 200, value: 0.38 });
      expect(first.baseline).toEqual({ count: 720, n: 6000, value: 0.12 });
      expect(first.companions).toEqual([{ rule: 'not_helpful_rate', value: 0.1, baseline: 0.09, n: 200 }]);
      expect(first.day).toBe(day(0));
    });

    it('never returns a field outside the contract, so no stored or injected text can reach the page', async () => {
      seedAlert(TENANT_A, { acknowledged_by: ADMIN_A, note: 'free text that must not be shown' });
      seedAlert(TENANT_A, { suggestion: 'free text in a code column' });
      const { list } = await routes();
      const body = await (await list.GET(get())).json();
      expect(body.alerts).toHaveLength(1);
      const keys = Object.keys(body.alerts[0]);
      expect(keys).not.toContain('note');
      expect(keys).not.toContain('acknowledged_by');
      expect(JSON.stringify(body)).not.toContain('free text');
    });

    it('status=open&limit=1 returns the banner count of all open alerts', async () => {
      for (let i = 0; i < 4; i += 1) seedAlert(TENANT_A, { day: day(i) });
      seedAlert(TENANT_A, { status: 'acknowledged' });
      seedAlert(TENANT_B);
      const { list } = await routes();
      const body = await (await list.GET(get('?status=open&limit=1'))).json();
      expect(body.alerts).toHaveLength(1);
      expect(body.alerts[0].status).toBe('open');
      expect(body.counts).toEqual({ open: 4, acknowledged: 1 });
      expect(typeof body.next_cursor).toBe('string');
    });

    it('orders open before acknowledged before resolved, alert before warning, newest day first', async () => {
      seedAlert(TENANT_A, { status: 'resolved', severity: 'alert', day: day(0) });
      seedAlert(TENANT_A, { status: 'acknowledged', severity: 'warning', day: day(0) });
      seedAlert(TENANT_A, { status: 'open', severity: 'warning', day: day(0) });
      seedAlert(TENANT_A, { status: 'acknowledged', severity: 'alert', day: day(3) });
      seedAlert(TENANT_A, { status: 'open', severity: 'alert', day: day(5) });
      seedAlert(TENANT_A, { status: 'open', severity: 'alert', day: day(1) });
      const { list } = await routes();
      const body = await (await list.GET(get('?status=all'))).json();
      expect(body.alerts.map((alert: Row) => `${alert.status}/${alert.severity}/${alert.day}`)).toEqual([
        `open/alert/${day(1)}`,
        `open/alert/${day(5)}`,
        `open/warning/${day(0)}`,
        `acknowledged/alert/${day(3)}`,
        `acknowledged/warning/${day(0)}`,
        `resolved/alert/${day(0)}`,
      ]);
    });

    it('defaults to open and acknowledged; status=resolved lists only resolved alerts', async () => {
      seedAlert(TENANT_A);
      seedAlert(TENANT_A, { status: 'acknowledged' });
      seedAlert(TENANT_A, { status: 'resolved' });
      const { list } = await routes();
      const active = await (await list.GET(get())).json();
      expect(active.alerts.map((alert: Row) => alert.status).sort()).toEqual(['acknowledged', 'open']);
      const resolved = await (await list.GET(get('?status=resolved'))).json();
      expect(resolved.alerts.map((alert: Row) => alert.status)).toEqual(['resolved']);
    });

    it('next_cursor pages through 60 alerts in pages of 20 without gaps or repeats', async () => {
      const statuses = ['open', 'acknowledged', 'resolved'];
      const severities = ['alert', 'warning'];
      for (let i = 0; i < 60; i += 1) {
        seedAlert(TENANT_A, { status: statuses[i % 3], severity: severities[i % 2], day: day(i % 7) });
      }
      const { list } = await routes();
      const all = await (await list.GET(get('?status=all&limit=50'))).json();
      const seen: Row[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?status=all&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await (await list.GET(get(query))).json();
        seen.push(...page.alerts);
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(60);
      expect(new Set(seen.map((alert) => alert.id)).size).toBe(60);
      expect(seen.slice(0, 50).map((alert) => alert.id)).toEqual(all.alerts.map((alert: Row) => alert.id));
    });

    it('filters by tenant, and a tenant the admin does not administer returns no alert', async () => {
      const both = [TENANT_A, TENANT_B];
      state.tenantKeys[ADMIN_A] = both;
      seedAlert(TENANT_A);
      seedAlert(TENANT_B);
      const { list } = await routes();
      const one = await (await list.GET(get(`?tenant=${encodeURIComponent(TENANT_B)}`))).json();
      expect(one.alerts.map((alert: Row) => alert.tenant_key)).toEqual([TENANT_B]);
      state.tenantKeys[ADMIN_A] = [TENANT_A];
      const other = await (await list.GET(get(`?tenant=${encodeURIComponent(TENANT_B)}`))).json();
      expect(other.alerts).toEqual([]);
      expect(other.counts).toEqual({ open: 0, acknowledged: 0 });
    });

    it('reports the monitor summary from the newest run row and the configured log level', async () => {
      state.runs.push(
        { id: uuid(1), ran_at: '2026-11-24T02:10:00.000Z', day: day(1), source: 'cli', groups_checked: 40, groups_insufficient: 20 },
        { id: uuid(2), ran_at: '2026-11-25T02:10:00.000Z', day: day(0), source: 'schedule', groups_checked: 48, groups_insufficient: 31 },
      );
      const { list } = await routes();
      const body = await (await list.GET(get())).json();
      expect(body.monitor).toEqual({
        enabled: true,
        last_run_day: day(0),
        last_run_at: '2026-11-25T02:10:00.000Z',
        log_level: 'ids',
        groups_checked: 48,
        groups_insufficient: 31,
      });
    });

    it('a monitor that never ran reports nulls', async () => {
      process.env.RAG_RETRIEVAL_LOG = 'masked_query';
      const { list } = await routes();
      const body = await (await list.GET(get())).json();
      expect(body.monitor).toEqual({
        enabled: true,
        last_run_day: null,
        last_run_at: null,
        log_level: 'masked_query',
        groups_checked: null,
        groups_insufficient: null,
      });
      expect(body.alerts).toEqual([]);
    });

    it.each([['?status=pending'], ['?limit=51'], ['?limit=0'], ['?tenant=u:not-a-key'], ['?cursor=not-a-cursor']])(
      'answers 400 for %s',
      async (query) => {
        const { list } = await routes();
        expect((await list.GET(get(query))).status).toBe(400);
      },
    );
  });

  describe('POST /api/rag/admin/monitor/alerts/{id}/{action}', () => {
    it('acknowledge moves an open alert of the admin tenant to acknowledged with the actor and time', async () => {
      const row = seedAlert(TENANT_A);
      const { action } = await routes();
      const response = await action.POST(post(String(row.id), 'acknowledge'), ctx(String(row.id), 'acknowledge'));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body.alert.status).toBe('acknowledged');
      expect(body.alert.acknowledged_at).toBe('2026-11-25T14:02:00.000Z');
      expect(MonitorAlertSchema.safeParse(body.alert).success).toBe(true);
      expect(state.setStatusCalls).toEqual([{ p_id: row.id, p_status: 'acknowledged', p_actor: ADMIN_A }]);
      expect(row.acknowledged_by).toBe(ADMIN_A);
    });

    it('resolve moves an acknowledged alert to resolved; a second resolve answers 409', async () => {
      const row = seedAlert(TENANT_A, { status: 'acknowledged' });
      const { action } = await routes();
      const first = await action.POST(post(String(row.id), 'resolve'), ctx(String(row.id), 'resolve'));
      expect(first.status).toBe(200);
      expect((await first.json()).alert.status).toBe('resolved');
      expect(row.resolved_by).toBe(ADMIN_A);
      const second = await action.POST(post(String(row.id), 'resolve'), ctx(String(row.id), 'resolve'));
      expect(second.status).toBe(409);
    });

    it('acknowledge of an acknowledged or resolved alert answers 409 and changes nothing', async () => {
      const acked = seedAlert(TENANT_A, { status: 'acknowledged' });
      const resolved = seedAlert(TENANT_A, { status: 'resolved' });
      const { action } = await routes();
      expect((await action.POST(post(String(acked.id), 'acknowledge'), ctx(String(acked.id), 'acknowledge'))).status).toBe(409);
      expect((await action.POST(post(String(resolved.id), 'acknowledge'), ctx(String(resolved.id), 'acknowledge'))).status).toBe(409);
      expect(acked.status).toBe('acknowledged');
      expect(resolved.status).toBe('resolved');
    });

    it('an alert of another tenant answers 404 and is never changed', async () => {
      const other = seedAlert(TENANT_B);
      const { action } = await routes();
      for (const verb of ['acknowledge', 'resolve']) {
        expect((await action.POST(post(String(other.id), verb), ctx(String(other.id), verb))).status).toBe(404);
      }
      expect(other.status).toBe('open');
      expect(state.setStatusCalls).toEqual([]);
    });

    it('an unknown id answers 404, an action other than the two 404, a malformed id 400', async () => {
      const row = seedAlert(TENANT_A);
      const { action } = await routes();
      const missing = uuid(0xdead);
      expect((await action.POST(post(missing, 'acknowledge'), ctx(missing, 'acknowledge'))).status).toBe(404);
      expect((await action.POST(post(String(row.id), 'delete'), ctx(String(row.id), 'delete'))).status).toBe(404);
      expect((await action.POST(post('not-a-uuid', 'resolve'), ctx('not-a-uuid', 'resolve'))).status).toBe(400);
      expect(row.status).toBe('open');
      expect(state.setStatusCalls).toEqual([]);
    });

    it('RAG_MONITOR off answers 404 without a query; a denied caller gets the guard status', async () => {
      const row = seedAlert(TENANT_A);
      process.env.RAG_MONITOR = 'false';
      const off = await routes();
      expect((await off.action.POST(post(String(row.id), 'acknowledge'), ctx(String(row.id), 'acknowledge'))).status).toBe(404);
      expect(state.queries).toEqual([]);
      process.env.RAG_MONITOR = 'true';
      state.guard = { ok: false, status: 401 };
      const on = await routes();
      expect((await on.action.POST(post(String(row.id), 'resolve'), ctx(String(row.id), 'resolve'))).status).toBe(401);
      expect(state.queries).toEqual([]);
      expect(row.status).toBe('open');
    });
  });
});
