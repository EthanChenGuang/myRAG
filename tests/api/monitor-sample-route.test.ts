import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000032c0';
const TENANT = `o:${ORG}`;
const OTHER_TENANT = 'o:00000000-0000-4000-8000-0000000032c1';

type Guard =
  | { ok: true; userId: string; via: 'deployment_admin' | 'organization_admin'; tenantKey: string; organizationId: string | null }
  | { ok: false; status: number; reason: string };

const STATUS = {
  enabled: true,
  missing: [],
  last_sample_at: '2026-11-23T03:00:00.000Z',
  added: 30,
  by_source: { representative: 18, pilot: 6, drift_fill: 6 },
  by_language: { xx: 20, yy: 10 },
  clusters: { count: 12, refit_at: '2026-11-03T03:00:00.000Z', novel: 41 },
};

const DRAWN = {
  written: true,
  week: '2026-W47',
  mining_window: '2026-11-16T00:00:00.000Z',
  candidates: 400,
  added: 30,
  by_source: { representative: 18, pilot: 6, drift_fill: 6 },
  by_language: { xx: 20, yy: 10 },
  excluded_queued: 2,
  clusters: { refit: false, count: 12, novel: 3 },
};

const state = {
  guard: { ok: false, status: 401, reason: 'no_session' } as Guard,
  guardCalls: 0,
  draws: [] as Array<Record<string, unknown>>,
  statusCalls: [] as string[],
  tenantsCalls: 0,
  drawResult: DRAWN as unknown,
  drawThrows: false,
  tenants: [TENANT, OTHER_TENANT],
  logs: [] as string[],
};

function mockSample() {
  const fake = {
    drawWeeklySample: async (_admin: unknown, options: Record<string, unknown>) => {
      state.draws.push(options);
      if (state.drawThrows) throw Object.assign(new Error('[Monitor] sample enqueue failed (XX000)'), { operation: 'enqueue', code: 'XX000' });
      return state.drawResult;
    },
    sampleStatus: async (_admin: unknown, tenantKey: string) => {
      state.statusCalls.push(tenantKey);
      return STATUS;
    },
    sampleTenants: async () => {
      state.tenantsCalls += 1;
      return state.tenants;
    },
  };
  vi.doMock('@/lib/rag/monitor/sample', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/rag/monitor/sample')>()), ...fake }));
  vi.doMock('@/lib/rag', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/rag')>()), ...fake }));
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdminOrOrgAdmin: async () => {
      state.guardCalls += 1;
      return state.guard;
    },
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({}), getSupabase: () => ({}) }));
  mockSample();
  return import('@/app/api/rag/admin/monitor/sample/route');
}

const req = (method: 'GET' | 'POST', query = `?organizationId=${ORG}`) => new Request(`http://localhost/api/rag/admin/monitor/sample${query}`, { method });

beforeEach(() => {
  state.guard = { ok: false, status: 401, reason: 'no_session' };
  state.guardCalls = 0;
  state.draws = [];
  state.statusCalls = [];
  state.tenantsCalls = 0;
  state.drawResult = DRAWN;
  state.drawThrows = false;
  state.tenants = [TENANT, OTHER_TENANT];
  state.logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      state.logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/rag');
  vi.doUnmock('@/lib/rag/monitor/sample');
  vi.doUnmock('@/lib/admin-route-auth');
  vi.doUnmock('@/lib/supabase');
});

describe('GET|POST /api/rag/admin/monitor/sample (D-39, UI-SPEC 8.1)', () => {
  it('answers 404 on both methods while RAG_REPRESENTATIVE_SAMPLE is off, before the admin guard', async () => {
    for (const value of [undefined, 'false', 'on']) {
      vi.unstubAllEnvs();
      if (value !== undefined) vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', value);
      const route = await loadRoute();
      state.guard = { ok: true, userId: 'u', via: 'deployment_admin', tenantKey: TENANT, organizationId: ORG };
      expect((await route.GET(req('GET'))).status).toBe(404);
      expect((await route.POST(req('POST'))).status).toBe(404);
    }
    expect(state.guardCalls).toBe(0);
    expect(state.draws).toEqual([]);
    expect(state.statusCalls).toEqual([]);
  });

  it("passes the guard's denial through without a read", async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    expect((await route.GET(req('GET'))).status).toBe(401);
    state.guard = { ok: false, status: 403, reason: 'not_admin' };
    expect((await route.POST(req('POST'))).status).toBe(403);
    expect(state.draws).toEqual([]);
    expect(state.statusCalls).toEqual([]);
  });

  it('GET returns the status of the workspace the guard resolved, counts only', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    state.guard = { ok: true, userId: 'u', via: 'organization_admin', tenantKey: TENANT, organizationId: ORG };
    const response = await route.GET(req('GET', `?organizationId=${ORG}&tenantKey=${encodeURIComponent(OTHER_TENANT)}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, ...STATUS });
    expect(state.statusCalls).toEqual([TENANT]);
  });

  it('POST draws the sample for that workspace and returns the status shape with the run counts', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    const route = await loadRoute();
    state.guard = { ok: true, userId: 'u', via: 'deployment_admin', tenantKey: TENANT, organizationId: ORG };
    const response = await route.POST(req('POST'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, ...STATUS, run: { written: true, week: '2026-W47', added: 30, excluded_queued: 2, missing: [] } });
    expect(state.draws.map((draw) => draw.tenantKey)).toEqual([TENANT]);
    expect(state.logs.join('\n')).not.toMatch(/synthetic|question text/i);
  });

  it('POST with a missing prerequisite reports it and draws nothing more', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    state.drawResult = { written: false, missing: ['log'] };
    const route = await loadRoute();
    state.guard = { ok: true, userId: 'u', via: 'deployment_admin', tenantKey: TENANT, organizationId: ORG };
    const body = await (await route.POST(req('POST'))).json();
    expect(body.run).toEqual({ written: false, week: null, added: 0, excluded_queued: 0, missing: ['log'] });
  });

  it('a failed draw answers 503 with no database message', async () => {
    vi.stubEnv('RAG_REPRESENTATIVE_SAMPLE', 'true');
    state.drawThrows = true;
    const route = await loadRoute();
    state.guard = { ok: true, userId: 'u', via: 'deployment_admin', tenantKey: TENANT, organizationId: ORG };
    const response = await route.POST(req('POST'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('XX000');
  });
});

describe('rag:monitor -- sample', () => {
  async function loadCli() {
    vi.resetModules();
    mockSample();
    return import('@/lib/rag/monitor/cli');
  }

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
  }

  const ENV = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key' };
  const ON = { ...ENV, RAG_REPRESENTATIVE_SAMPLE: 'true', RAG_RETRIEVAL_LOG: 'masked_query', RAG_DOMAIN_EXPERT_REVIEW: 'true' };

  it('parses sample with an optional --tenant', async () => {
    const { parseMonitorArgs } = await loadCli();
    expect(parseMonitorArgs(['sample'])).toEqual({ command: 'sample' });
    expect(parseMonitorArgs(['sample', '--tenant', TENANT])).toEqual({ command: 'sample', tenant: TENANT });
    expect(parseMonitorArgs(['sample', '--tenant', 'acme']).command).toBe('invalid');
    expect(parseMonitorArgs(['sample', '--since', '2026-11-01']).command).toBe('invalid');
  });

  it('a missing prerequisite prints a notice naming it, returns 0 and creates no client', async () => {
    const { main } = await loadCli();
    const { io, out } = capture();
    const createClient = () => {
      throw new Error('no client may be created');
    };
    expect(await main(['sample'], io, { env: { ...ENV, RAG_RETRIEVAL_LOG: 'ids' }, createClient })).toBe(0);
    expect(out.join('\n')).toMatch(/RAG_REPRESENTATIVE_SAMPLE/);
    expect(out.join('\n')).toMatch(/RAG_RETRIEVAL_LOG=masked_query/);
    expect(out.join('\n')).toMatch(/RAG_DOMAIN_EXPERT_REVIEW/);
    expect(state.draws).toEqual([]);
  });

  it('runs every tenant with log rows in the week, or the one named, and prints counts only', async () => {
    const { main } = await loadCli();
    const createClient = (() => ({})) as never;
    const all = capture();
    expect(await main(['sample'], all.io, { env: ON, createClient, now: new Date('2026-11-25T12:00:00Z') })).toBe(0);
    expect(state.tenantsCalls).toBe(1);
    expect(state.draws.map((draw) => draw.tenantKey)).toEqual([TENANT, OTHER_TENANT]);
    expect(all.out.join('\n')).toMatch(/representative 18, pilot 6, drift_fill 6/);
    expect(all.out.join('\n')).not.toContain(ORG);

    state.draws = [];
    const one = capture();
    expect(await main(['sample', '--tenant', TENANT], one.io, { env: ON, createClient })).toBe(0);
    expect(state.draws.map((draw) => draw.tenantKey)).toEqual([TENANT]);
    expect(state.tenantsCalls).toBe(1);
  });

  it('does not need RAG_MONITOR and returns 1 when a tenant fails', async () => {
    const { main } = await loadCli();
    state.drawThrows = true;
    const { io, err } = capture();
    expect(await main(['sample', '--tenant', TENANT], io, { env: ON, createClient: (() => ({})) as never })).toBe(1);
    expect(err.join('\n')).toMatch(/sample failed/);
    expect(err.join('\n')).not.toContain('XX000 failed');
  });
});
