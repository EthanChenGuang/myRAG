import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ID, USER_ID, silenceConsole } from '../helpers/admin-guard-fixture';

const TENANT = 'o:00000000-0000-4000-8000-0000000000c1';
const OTHER = 'o:00000000-0000-4000-8000-0000000000c2';

interface State {
  session: { id: string } | null;
  lookupFails: boolean;
  guardCalls: number;
  calls: Array<Record<string, unknown>>;
  report: unknown;
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

const CELL = {
  tenant_key: null,
  language: 'en',
  window: { since: '2026-03-01', until: '2026-03-05' },
  retrievals: 100,
  refused: 30,
  kb_unavailable: 1,
  votes_up: 4,
  votes_down: 3,
  low_confidence: 6,
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
      languageQualityForAdmin: async (_client: unknown, input: Record<string, unknown>) => {
        state.calls.push(input);
        return state.report;
      },
    };
  });
  return import('@/app/api/rag/admin/language-quality/route');
}

function req(query: string) {
  return new NextRequest(`http://localhost/api/rag/admin/language-quality?${query}`);
}

beforeEach(() => {
  state = { session: null, lookupFails: false, guardCalls: 0, calls: [], report: { ok: true, cells: [CELL], judge: { en: { n: 60, mean: 0.7 } } } };
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

describe('GET /api/rag/admin/language-quality (LANG-10)', () => {
  it('answers 404 with RAG_MONITOR off before the admin guard runs any query', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.GET(req('since=2026-03-01&until=2026-03-05'));
    expect(response.status).toBe(404);
    expect(state.guardCalls).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it('fails closed: 401 without a session, 403 for a non-admin, 503 when the lookup fails', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    const route = await loadRoute();
    expect((await route.GET(req('since=2026-03-01&until=2026-03-05'))).status).toBe(401);
    state.session = { id: USER_ID };
    expect((await route.GET(req('since=2026-03-01&until=2026-03-05'))).status).toBe(403);
    state.session = { id: ADMIN_ID };
    state.lookupFails = true;
    expect((await route.GET(req('since=2026-03-01&until=2026-03-05'))).status).toBe(503);
    expect(state.calls).toEqual([]);
  });

  it('rejects a window over 90 days, a reversed window and a malformed tenant key', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    expect((await route.GET(req('since=2026-01-01&until=2026-03-31'))).status).toBe(200);
    expect((await route.GET(req('since=2026-01-01&until=2026-04-01'))).status).toBe(400);
    expect((await route.GET(req('since=2026-03-05&until=2026-03-01'))).status).toBe(400);
    expect((await route.GET(req('since=2026-03-01&until=2026-03-05&tenant=bad'))).status).toBe(400);
    expect((await route.GET(req('until=2026-03-05'))).status).toBe(400);
    expect(state.calls).toHaveLength(1);
  });

  it('returns the cells and judge means with counts and codes only, passing tenants and the per-tenant flag', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.GET(req(`since=2026-03-01&until=2026-03-05&tenant=${TENANT}&tenant=${OTHER}&by_tenant=true`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ window: { since: '2026-03-01', until: '2026-03-05' }, cells: [CELL], judge: { en: { n: 60, mean: 0.7 } } });
    expect(state.calls[0]).toEqual({
      actorUserId: ADMIN_ID,
      window: { since: '2026-03-01', until: '2026-03-05' },
      tenants: [TENANT, OTHER],
      byTenant: true,
    });
  });

  it('maps a tenant the admin does not administer to 403 and a read failure to 503', async () => {
    vi.stubEnv('RAG_MONITOR', 'true');
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    state.report = { ok: false, reason: 'forbidden' };
    expect((await route.GET(req(`since=2026-03-01&until=2026-03-05&tenant=${OTHER}`))).status).toBe(403);
    state.report = { ok: false, reason: 'unavailable' };
    expect((await route.GET(req('since=2026-03-01&until=2026-03-05'))).status).toBe(503);
  });
});
