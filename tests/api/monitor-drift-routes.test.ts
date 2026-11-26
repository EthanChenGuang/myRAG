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
