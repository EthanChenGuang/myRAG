import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ID, USER_ID, silenceConsole } from '../helpers/admin-guard-fixture';

interface State {
  session: { id: string } | null;
  lookupFails: boolean;
  guardCalls: number;
  runCalls: Array<Record<string, unknown>>;
  deliverCalls: number;
  runResult: unknown;
  runThrows: boolean;
}

let state: State;

function fakeAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      if (table === 'admin_users') state.guardCalls += 1;
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'abortSignal']) builder[method] = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      builder.maybeSingle = () =>
        Promise.resolve(state.lookupFails ? { data: null, error: { message: 'down' } } : { data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null });
      return builder;
    },
  };
}

const RAN = {
  ran: true,
  day: '2026-03-05',
  daysAggregated: 7,
  cellsRead: 40,
  groupsChecked: 6,
  groupsInsufficient: 1,
  candidates: 2,
  alertsOpened: 1,
  alertsUpdated: 1,
  alertsSuppressed: 0,
  alertsInvalid: 0,
  deliveries: 1,
  rulesUnregistered: [],
  contextRulesFailed: [],
};

const DELIVERY = {
  alerts: 1,
  attempted: 1,
  banner: 1,
  channels: {
    webhook: { pending: 0, delivered: 1, failed: 0, disabled: 0 },
    langfuse: { pending: 0, delivered: 0, failed: 0, disabled: 1 },
  },
  writeFailures: 0,
};

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  const admin = fakeAdmin();
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin, getSupabase: () => ({}) }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...original,
      runDaily: async (_client: unknown, options: Record<string, unknown>) => {
        state.runCalls.push(options);
        if (state.runThrows) throw Object.assign(new Error('[Monitor] rag_monitor_aggregate failed (XX000)'), { code: 'XX000' });
        return state.runResult;
      },
      deliverStoredAlerts: async () => {
        state.deliverCalls += 1;
        return DELIVERY;
      },
    };
  });
  return import('@/app/api/rag/admin/monitor/run/route');
}

function req() {
  return new NextRequest('http://localhost/api/rag/admin/monitor/run', { method: 'POST' });
}

beforeEach(() => {
  state = { session: null, lookupFails: false, guardCalls: 0, runCalls: [], deliverCalls: 0, runResult: RAN, runThrows: false };
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/rag');
});

describe('POST /api/rag/admin/monitor/run (D-20, D-21)', () => {
  it('answers 404 with RAG_MONITOR off before the admin guard runs any query', async () => {
    state.session = { id: ADMIN_ID };
    for (const value of [undefined, 'false', 'yes']) {
      vi.unstubAllEnvs();
      if (value !== undefined) vi.stubEnv('RAG_MONITOR', value);
      const route = await loadRoute();
      const response = await route.POST(req());
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.guardCalls).toBe(0);
    expect(state.runCalls).toEqual([]);
  });

  it('runs the admin guard: 401 without a session, 403 for a non-admin, 503 when the lookup fails', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    const route = await loadRoute();
    expect((await route.POST(req())).status).toBe(401);
    state.session = { id: USER_ID };
    expect((await route.POST(req())).status).toBe(403);
    state.session = { id: ADMIN_ID };
    state.lookupFails = true;
    expect((await route.POST(req())).status).toBe(503);
    expect(state.runCalls).toEqual([]);
  });

  it('runs the daily job with source route, delivers, and returns the counts', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.POST(req());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ success: true, ran: true, day: '2026-03-05', days_aggregated: 7, alerts_opened: 1, alerts_updated: 1 });
    expect(body.delivery).toEqual({ alerts: 1, webhook: DELIVERY.channels.webhook, langfuse: DELIVERY.channels.langfuse });
    expect(state.runCalls).toHaveLength(1);
    expect(state.runCalls[0]!.source).toBe('route');
    expect(state.deliverCalls).toBe(1);
  });

  it('returns zero counts without delivery when the retrieval log is off', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    state.session = { id: ADMIN_ID };
    state.runResult = { ran: false, reason: 'log_off' };
    const route = await loadRoute();
    const response = await route.POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, ran: false, reason: 'log_off', days_aggregated: 0, alerts_opened: 0, alerts_updated: 0 });
    expect(state.deliverCalls).toBe(0);
  });

  it('answers 503 with the structured error shape when the database fails, leaking no detail', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    state.session = { id: ADMIN_ID };
    state.runThrows = true;
    const route = await loadRoute();
    const response = await route.POST(req());
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(JSON.stringify(body)).not.toContain('XX000');
  });
});

describe('supabase/optional/monitor-schedule.sql (O-2)', () => {
  const file = path.join(process.cwd(), 'supabase/optional/monitor-schedule.sql');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  it('holds cron.schedule only inside comments and calls rag_monitor_aggregate only', () => {
    expect(text).toContain('rag_monitor_aggregate');
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim();
    expect(code).toBe('');
    const functions = [...text.matchAll(/public\.(rag_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]);
    expect(functions.length).toBeGreaterThan(0);
    expect(new Set(functions)).toEqual(new Set(['rag_monitor_aggregate']));
    expect(text).toMatch(/cron\.schedule\(/);
  });

  it('holds no secret, URL or key', () => {
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/service_role_key|apikey|authorization|bearer|secret\s*=/i);
  });
});
