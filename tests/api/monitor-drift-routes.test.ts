import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAdmin, type FakeAdmin } from '../helpers/monitor-drift-fake';

const TENANT = 'o:00000000-0000-4000-8000-0000000033b0';
const OTHER_TENANT = 'o:00000000-0000-4000-8000-0000000033b1';
const ADMIN_ID = '00000000-0000-4000-8000-0000000033f1';
const NOW = new Date('2026-11-26T12:00:00.000Z');

type Guard = { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string };

const state = {
  guard: { ok: true, userId: ADMIN_ID } as Guard,
  guardCalls: 0,
  admin: null as FakeAdmin | null,
};

function day(overrides: Record<string, unknown>) {
  return {
    tenant_key: TENANT,
    day: '2026-11-20',
    language: 'xx',
    rag_mode: 'strict',
    channel: 'chat',
    doc_type: 'all',
    retrievals: 0,
    refused: 0,
    helpful: 0,
    not_helpful: 0,
    judged: 0,
    judge_score_sums: {},
    ...overrides,
  };
}

const SHARE_ROWS: Record<string, Array<{ cluster_id: string; language: string; channel: string; n: number }>> = {
  [TENANT]: [
    { cluster_id: 'c-01', language: 'xx', channel: 'chat', n: 50 },
    { cluster_id: 'c-01', language: 'yy', channel: 'voice', n: 10 },
    { cluster_id: 'c-02', language: 'xx', channel: 'chat', n: 30 },
    { cluster_id: 'novel', language: 'und', channel: 'chat', n: 10 },
  ],
  [OTHER_TENANT]: [{ cluster_id: 'c-99', language: 'xx', channel: 'chat', n: 1000 }],
};

function seed(): FakeAdmin {
  const admin = fakeAdmin({
    rag_monitor_daily: [
      day({ retrievals: 80, refused: 8, helpful: 15, not_helpful: 5, judged: 40, judge_score_sums: { faithfulness: 32, answer_relevance: 36 } }),
      day({ day: '2026-11-21', language: 'yy', channel: 'voice', retrievals: 20, refused: 2, helpful: 3, not_helpful: 1, judged: 10, judge_score_sums: { faithfulness: 6, answer_relevance: 8 } }),
      day({ day: '2026-10-01', retrievals: 999, refused: 999, judged: 999, judge_score_sums: { faithfulness: 1 } }),
      day({ tenant_key: OTHER_TENANT, retrievals: 5000, refused: 4000, not_helpful: 900, judged: 900, judge_score_sums: { faithfulness: 1 } }),
    ],
  });
  admin.rpcs.rag_admin_tenant_keys = () => ({ data: [TENANT], error: null });
  admin.rpcs.rag_monitor_cluster_shares = (args) => ({ data: SHARE_ROWS[String(args.p_tenant_key)] ?? [], error: null });
  return admin;
}

function mockCommon() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdmin: async () => {
      state.guardCalls += 1;
      return state.guard;
    },
  }));
  vi.doMock('@/lib/deployment-mode', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/deployment-mode')>()),
    getDeploymentMode: () => 'multi-tenant',
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => state.admin?.client ?? null, getSupabase: () => ({}) }));
}

async function loadInputsRoute() {
  mockCommon();
  return import('@/app/api/rag/admin/monitor/drift-inputs/route');
}

const get = (query: string) =>
  new Request(`http://localhost/api/rag/admin/monitor/drift-inputs${query}`, { method: 'GET', headers: { authorization: 'Bearer test-token' } });

const EXPECTED_CLUSTERS = [
  { id: 'c-01', n: 60, share: 0.6 },
  { id: 'c-02', n: 30, share: 0.3 },
  { id: 'novel', n: 10, share: 0.1 },
];

beforeEach(() => {
  state.guard = { ok: true, userId: ADMIN_ID };
  state.guardCalls = 0;
  state.admin = seed();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const id of ['@/lib/admin-route-auth', '@/lib/deployment-mode', '@/lib/supabase']) vi.doUnmock(id);
});

describe('driftInputs (D-43)', () => {
  it('returns cluster shares summing to 1 with novel, and per-slice judge means, vote and refusal rates as numbers', async () => {
    const { driftInputs } = await import('@/lib/rag/monitor/drift-inputs');
    const admin = seed();
    const inputs = await driftInputs(admin.client as never, { tenantKey: TENANT, now: NOW });
    expect(inputs.window).toEqual({ days: 30, since: '2026-10-27T12:00:00.000Z', until: NOW.toISOString() });
    expect(inputs.total).toBe(100);
    expect(inputs.clusters).toEqual(EXPECTED_CLUSTERS);
    expect(inputs.clusters.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 9);
    const bySlice = Object.fromEntries(inputs.slices.map((s) => [s.slice, s]));
    expect(Object.keys(bySlice).sort()).toEqual(['all', 'channel:chat', 'channel:voice', 'language:xx', 'language:yy']);
    expect(bySlice.all.online_judge.mean).toBeCloseTo((32 / 50 + 36 / 50 + 6 / 50 + 8 / 50) / 2, 12);
    expect(bySlice.all).toEqual({
      slice: 'all',
      online_judge: { mean: expect.any(Number), n: 50 },
      not_helpful_rate: { value: 6 / 24, count: 6, n: 24 },
      refusal_rate: { value: 10 / 100, count: 10, n: 100 },
    });
    expect(bySlice['language:xx'].online_judge.n).toBe(40);
    expect(bySlice['language:xx'].online_judge.mean).toBeCloseTo((32 / 40 + 36 / 40) / 2, 12);
    expect(bySlice['channel:voice'].refusal_rate).toEqual({ value: 0.1, count: 2, n: 20 });
    const json = JSON.stringify(inputs);
    expect(json).not.toContain('c-99');
    const shareCall = admin.rpcCalls.find((call) => call.name === 'rag_monitor_cluster_shares');
    expect(shareCall?.args).toEqual({ p_tenant_key: TENANT, p_since: '2026-10-27T12:00:00.000Z' });
    for (const call of admin.calls) expect(call.filters).toContainEqual({ op: 'eq', column: 'tenant_key', value: TENANT });
  });

  it('gives null means and rates, not zero, when nothing was judged, voted or retrieved', async () => {
    const { driftInputs } = await import('@/lib/rag/monitor/drift-inputs');
    const admin = fakeAdmin({ rag_monitor_daily: [] });
    admin.rpcs.rag_monitor_cluster_shares = () => ({ data: [], error: null });
    const inputs = await driftInputs(admin.client as never, { tenantKey: TENANT, now: NOW });
    expect(inputs.clusters).toEqual([]);
    expect(inputs.total).toBe(0);
    expect(inputs.slices).toEqual([
      { slice: 'all', online_judge: { mean: null, n: 0 }, not_helpful_rate: { value: null, count: 0, n: 0 }, refusal_rate: { value: null, count: 0, n: 0 } },
    ]);
  });
});

describe('GET /api/rag/admin/monitor/drift-inputs (D-43)', () => {
  it('answers 404 while RAG_REPRESENTATIVE_SAMPLE is off, before the admin guard', async () => {
    const route = await loadInputsRoute();
    expect((await route.GET(get(`?tenant=${TENANT}`))).status).toBe(404);
    expect(state.guardCalls).toBe(0);
  });

  it("returns the admin's tenant inputs, numbers only", async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadInputsRoute();
    const response = await route.GET(get(`?tenant=${TENANT}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.clusters).toEqual(EXPECTED_CLUSTERS);
    expect(body.slices).toHaveLength(5);
  });

  it('answers 403 for another tenant and 400 for a bad query, reading nothing of either', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadInputsRoute();
    expect((await route.GET(get(`?tenant=${OTHER_TENANT}`))).status).toBe(403);
    expect((await route.GET(get('?tenant=nope'))).status).toBe(400);
    expect((await route.GET(get(`?tenant=${TENANT}&extra=1`))).status).toBe(400);
    expect((await route.GET(get(''))).status).toBe(400);
    expect(state.admin?.calls).toEqual([]);
    expect(state.admin?.rpcCalls.map((call) => call.name)).not.toContain('rag_monitor_cluster_shares');
  });

  it("passes the guard's denial through", async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    state.guard = { ok: false, status: 401, reason: 'no_session' };
    const route = await loadInputsRoute();
    expect((await route.GET(get(`?tenant=${TENANT}`))).status).toBe(401);
    expect(state.admin?.rpcCalls).toEqual([]);
  });
});

describe('npm run rag:monitor -- drift-inputs (D-43)', () => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-placeholder',
    RAG_REPRESENTATIVE_SAMPLE: 'true',
  };

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
  }

  it('prints the same JSON as the route for --tenant and returns 0', async () => {
    const { main } = await import('@/lib/rag/monitor/cli');
    const { driftInputs } = await import('@/lib/rag/monitor/drift-inputs');
    const admin = seed();
    const capture = io();
    const code = await main(['drift-inputs', '--tenant', TENANT], capture.io, { env, createClient: () => admin.client as never, now: NOW });
    expect(code).toBe(0);
    expect(capture.out).toHaveLength(1);
    expect(JSON.parse(capture.out[0] as string)).toEqual(JSON.parse(JSON.stringify(await driftInputs(seed().client as never, { tenantKey: TENANT, now: NOW }))));
  });

  it('returns 2 for a missing or invalid tenant key', async () => {
    const { main } = await import('@/lib/rag/monitor/cli');
    for (const argv of [['drift-inputs'], ['drift-inputs', '--tenant', 'not-a-key'], ['drift-inputs', '--tenant', TENANT, '--extra', 'x']]) {
      const capture = io();
      expect(await main(argv, capture.io, { env, createClient: () => seed().client as never, now: NOW })).toBe(2);
    }
  });

  it('prints a notice and reads nothing while RAG_REPRESENTATIVE_SAMPLE is off', async () => {
    const { main } = await import('@/lib/rag/monitor/cli');
    const admin = seed();
    const capture = io();
    let created = 0;
    const code = await main(['drift-inputs', '--tenant', TENANT], capture.io, {
      env: { ...env, RAG_REPRESENTATIVE_SAMPLE: 'false' },
      createClient: () => {
        created += 1;
        return admin.client as never;
      },
      now: NOW,
    });
    expect(code).toBe(0);
    expect(created).toBe(0);
    expect(capture.out.join('\n')).toContain('RAG_REPRESENTATIVE_SAMPLE');
  });
});

const ORG = '00000000-0000-4000-8000-0000000033b0';

const REPORT = {
  week: '2026-W47',
  state: 'ok',
  divergence: 0.24,
  null_p95: 0.07,
  limits: { warn: 0.1, alert: 0.2, gap: 0.15 },
  clusters: [
    { id: 'c-07', production_share: 0.22, test_share: 0.04, test_items: 3, state: 'ok' },
    { id: 'c-03', production_share: 0.78, test_share: 0.96, test_items: 64, state: 'ok' },
  ],
};

type WorkspaceGuard =
  | { ok: true; userId: string; via: 'deployment_admin' | 'organization_admin'; tenantKey: string; organizationId: string | null }
  | { ok: false; status: number; reason: string };

const workspace = { guard: { ok: true, userId: ADMIN_ID, via: 'organization_admin', tenantKey: TENANT, organizationId: ORG } as WorkspaceGuard, calls: 0 };

function driftStore(admin: FakeAdmin): FakeAdmin {
  admin.tables.rag_drift_weekly = admin.tables.rag_drift_weekly ?? [];
  admin.tables.rag_monitor_alerts = admin.tables.rag_monitor_alerts ?? [];
  admin.rpcs.rag_drift_weekly_upsert = (args) => {
    const rows = admin.tables.rag_drift_weekly as Array<Record<string, unknown>>;
    const report = args.p_report as Record<string, unknown>;
    const existing = rows.find((row) => row.tenant_key === args.p_tenant_key && row.week === args.p_week);
    const values = { divergence: report.divergence, null_p95: report.null_p95 ?? null, state: report.state, report };
    if (existing) Object.assign(existing, values);
    else rows.push({ tenant_key: args.p_tenant_key, week: args.p_week, ...values });
    return { data: !existing, error: null };
  };
  admin.rpcs.rag_monitor_alert_upsert = (args) => {
    const rows = admin.tables.rag_monitor_alerts as Array<Record<string, unknown>>;
    const alert = args.p_alert as Record<string, unknown>;
    const existing = rows.find((row) => row.tenant_key === alert.tenant_key && row.dedup_key === alert.dedup_key);
    if (existing) return { data: existing.id, error: null };
    rows.push({ ...alert, id: `alert-${rows.length + 1}`, status: 'open' });
    return { data: `alert-${rows.length}`, error: null };
  };
  return admin;
}

async function loadDriftRoute() {
  mockCommon();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdmin: async () => {
      state.guardCalls += 1;
      return state.guard;
    },
    checkAdminOrOrgAdmin: async () => {
      workspace.calls += 1;
      return workspace.guard;
    },
  }));
  return import('@/app/api/rag/admin/monitor/drift/route');
}

const postDrift = (body: unknown) =>
  new Request('http://localhost/api/rag/admin/monitor/drift', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });

const getDrift = (query = `?organizationId=${ORG}`) => new Request(`http://localhost/api/rag/admin/monitor/drift${query}`, { method: 'GET' });

describe('GET|POST /api/rag/admin/monitor/drift (D-44, D-45, UI-SPEC 8.1)', () => {
  beforeEach(() => {
    state.admin = driftStore(seed());
    workspace.guard = { ok: true, userId: ADMIN_ID, via: 'organization_admin', tenantKey: TENANT, organizationId: ORG };
    workspace.calls = 0;
  });

  it('answers 404 on both methods while RAG_REPRESENTATIVE_SAMPLE is off, even with RAG_MONITOR on', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    const route = await loadDriftRoute();
    expect((await route.POST(postDrift({ tenant: TENANT, report: REPORT }))).status).toBe(404);
    expect((await route.GET(getDrift())).status).toBe(404);
    expect(state.guardCalls + workspace.calls).toBe(0);
    expect(state.admin?.rpcCalls).toEqual([]);
  });

  it('POST stores the recomputed report and raises the alert only with RAG_MONITOR on', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    let route = await loadDriftRoute();
    let response = await route.POST(postDrift({ tenant: TENANT, report: REPORT }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, week: '2026-W47', state: 'alert', inserted: true, alerts: { opened: 0, updated: 0 } });
    expect(state.admin?.tables.rag_monitor_alerts).toEqual([]);

    vi.stubEnv('RAG_MONITOR', 'true');
    route = await loadDriftRoute();
    response = await route.POST(postDrift({ tenant: TENANT, report: REPORT }));
    expect(await response.json()).toMatchObject({ success: true, state: 'alert', inserted: false, alerts: { opened: 1 } });
    const alerts = state.admin?.tables.rag_monitor_alerts as Array<Record<string, unknown>>;
    expect(alerts.map((a) => [a.rule, a.cluster_ids])).toEqual([['test_set_not_representative', ['c-07']]]);
  });

  it('POST answers 403 for a tenant the admin does not administer and 400 with the shared shape for an invalid report', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadDriftRoute();
    expect((await route.POST(postDrift({ tenant: OTHER_TENANT, report: REPORT }))).status).toBe(403);
    for (const body of [{ tenant: TENANT, report: { ...REPORT, divergence: 2 } }, { tenant: TENANT, report: REPORT, extra: 1 }, { tenant: TENANT }]) {
      const response = await route.POST(postDrift(body));
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json).toMatchObject({ success: false, error: 'Invalid request data' });
      expect(json.details.length).toBeGreaterThan(0);
    }
    expect(state.admin?.rpcCalls.map((call) => call.name)).not.toContain('rag_drift_weekly_upsert');
  });

  it('GET returns the coverage view of the workspace the guard resolved', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadDriftRoute();
    await route.POST(postDrift({ tenant: TENANT, report: REPORT }));
    const response = await route.GET(getDrift(`?organizationId=${ORG}&tenantKey=${encodeURIComponent(OTHER_TENANT)}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ success: true, week: '2026-W47', state: 'alert', limits: { warn: 0.1, alert: 0.2, gap: 0.15 } });
    expect(body.trend).toEqual([{ week: '2026-W47', divergence: 0.24, state: 'alert' }]);
    expect(body.clusters.map((c: { id: string; state: string }) => [c.id, c.state])).toEqual([
      ['c-03', 'off'],
      ['c-07', 'under'],
    ]);
  });

  it("GET passes the workspace guard's denial through", async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    workspace.guard = { ok: false, status: 403, reason: 'not_admin' };
    const route = await loadDriftRoute();
    expect((await route.GET(getDrift())).status).toBe(403);
    expect(state.admin?.calls).toEqual([]);
  });
});
