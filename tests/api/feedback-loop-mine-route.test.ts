import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiningRunResultSchema } from '@/lib/rag-eval/contracts.generated';
import { ADMIN_ID, USER_ID, silenceConsole } from '../helpers/admin-guard-fixture';

const TENANT_A = 'o:11111111-1111-4111-8111-111111111111';
const TENANT_B = 's:default';

interface State {
  session: { id: string } | null;
  authThrows: boolean;
  lookupFails: boolean;
  dataCalls: string[];
  rpcArgs: Array<Record<string, unknown>>;
  miningFails: boolean;
}

let state: State;

/** admin_users for the guard; the purge and mining RPCs and the review-items delete for the route. Every non-guard call is recorded. */
function fakeAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    rpc(name: string, args: Record<string, unknown>) {
      state.dataCalls.push(`rpc:${name}`);
      state.rpcArgs.push(args);
      if (name === 'rag_purge_retrieval_log') return Promise.resolve({ data: 0, error: null });
      if (state.miningFails) return Promise.resolve({ data: null, error: { code: '42501', message: 'secret detail' } });
      return Promise.resolve({
        data: [
          { tenant_key: TENANT_A, reason: 'feedback_negative', inserted: 1, tenant_inserted: 2 },
          { tenant_key: TENANT_A, reason: 'zero_results', inserted: 1, tenant_inserted: 2 },
          { tenant_key: TENANT_B, reason: 'low_score', inserted: 1, tenant_inserted: 1 },
        ],
        error: null,
      });
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      if (table !== 'admin_users') state.dataCalls.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'abortSignal', 'delete', 'lt']) builder[method] = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      const settle = () => {
        if (table === 'admin_users') {
          if (state.lookupFails) return { data: null, error: { message: 'down' } };
          return { data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null };
        }
        return { data: null, error: null, count: 0 };
      };
      builder.maybeSingle = () => Promise.resolve(settle());
      builder.single = () => Promise.resolve(settle());
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(onFulfilled, onRejected);
      return builder;
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  const admin = fakeAdmin();
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin, getSupabase: () => ({}) }));
  return import('@/app/api/rag/admin/feedback-loop/mine/route');
}

function req(body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/rag/admin/feedback-loop/mine', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

function enable() {
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.stubEnv('RAG_RETRIEVAL_LOG', 'masked_query');
}

beforeEach(() => {
  state = { session: null, authThrows: false, lookupFails: false, dataCalls: [], rpcArgs: [], miningFails: false };
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('POST /api/rag/admin/feedback-loop/mine (D-15)', () => {
  it('runs the admin guard first: 401, forged cookie 401, 403, 503, and calls nothing before it', async () => {
    enable();
    const route = await loadRoute();
    const body = { since: '2026-11-01', until: '2026-11-08' };
    expect((await route.POST(req(body))).status).toBe(401);
    expect((await route.POST(req(body, { cookie: 'admin_session=forged-value' }))).status).toBe(401);
    state.session = { id: USER_ID };
    expect((await route.POST(req(body))).status).toBe(403);
    state.session = { id: ADMIN_ID };
    state.lookupFails = true;
    expect((await route.POST(req(body))).status).toBe(503);
    state.session = null;
    state.lookupFails = false;
    state.authThrows = true;
    expect((await route.POST(req(body))).status).toBe(503);
    expect(state.dataCalls).toEqual([]);
  });

  it('answers 404 and calls nothing when review is off or the log is not masked_query', async () => {
    state.session = { id: ADMIN_ID };
    for (const env of [{}, { RAG_DOMAIN_EXPERT_REVIEW: 'true', RAG_RETRIEVAL_LOG: 'ids' }, { RAG_RETRIEVAL_LOG: 'masked_query' }]) {
      vi.unstubAllEnvs();
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const route = await loadRoute();
      const response = await route.POST(req({ since: '2026-11-01', until: '2026-11-08' }));
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.dataCalls).toEqual([]);
  });

  it('answers 400 for a 40-day window, a reversed window, a bad date, an extra field or a body that is not JSON', async () => {
    enable();
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    for (const body of [
      { since: '2026-09-29', until: '2026-11-08' },
      { since: '2026-11-08', until: '2026-11-01' },
      { since: 'tomorrow' },
      { since: '2026-11-01', until: '2026-11-08', tenantKey: TENANT_A },
      '{not json',
      [],
    ]) {
      const response = await route.POST(req(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(state.dataCalls).toEqual([]);
  });

  it('an admin POST purges, mines the window and returns the MiningRunResult with tenant hashes only', async () => {
    enable();
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.POST(req({ since: '2026-11-01', until: '2026-11-08T00:00:00Z' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await response.json();
    expect(json.success).toBe(true);
    const result = MiningRunResultSchema.parse(json.result);
    expect(result.status).toBe('completed');
    expect(result.since).toBe('2026-11-01T00:00:00.000Z');
    expect(result.until).toBe('2026-11-08T00:00:00.000Z');
    expect(result.total_inserted).toBe(3);
    expect(state.dataCalls).toEqual(['rpc:rag_purge_retrieval_log', 'rag_review_items', 'rpc:rag_mine_failed_queries_report']);
    expect(state.rpcArgs[1]).toMatchObject({ p_since: '2026-11-01T00:00:00.000Z', p_until: '2026-11-08T00:00:00.000Z' });
    const text = JSON.stringify(json);
    expect(text).not.toContain(TENANT_A.slice(2));
    expect(text).not.toContain(TENANT_B);
  });

  it('accepts an empty body: until is now and since is until minus window_days', async () => {
    enable();
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.POST(req());
    expect(response.status).toBe(200);
    const result = MiningRunResultSchema.parse((await response.json()).result);
    expect(Date.parse(result.until) - Date.parse(result.since)).toBe(7 * 86_400_000);
  });

  it('answers 503 with the error code only when mining fails', async () => {
    enable();
    state.session = { id: ADMIN_ID };
    state.miningFails = true;
    const route = await loadRoute();
    const response = await route.POST(req({ since: '2026-11-01', until: '2026-11-08' }));
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('42501');
    expect(text).not.toContain('secret detail');
  });
});
