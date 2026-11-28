import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ID, USER_ID, silenceConsole } from '../helpers/admin-guard-fixture';

const ORG = '22222222-2222-4222-8222-222222222222';
const TENANT = `o:${ORG}`;

interface State {
  session: { id: string } | null;
  authThrows: boolean;
  lookupFails: boolean;
  settings: Map<string, Record<string, unknown>>;
  dataCalls: string[];
}

let state: State;

/** admin_users for the guard, the settings table for the routes; every non-guard call is recorded. */
function fakeAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    rpc(name: string) {
      state.dataCalls.push(`rpc:${name}`);
      return Promise.resolve({ data: 0, error: null });
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let upsert: Record<string, unknown> | null = null;
      if (table !== 'admin_users') state.dataCalls.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'abortSignal', 'delete', 'lt']) builder[method] = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      builder.upsert = (row: Record<string, unknown>) => {
        upsert = row;
        return builder;
      };
      const settle = () => {
        if (table === 'admin_users') {
          if (state.lookupFails) return { data: null, error: { message: 'down' } };
          return { data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null };
        }
        if (table === 'rag_tenant_feedback_settings') {
          if (upsert) {
            const row = { ...upsert, updated_at: '2026-11-25T00:00:00.000Z' };
            state.settings.set(String(upsert.tenant_key), row);
            return { data: row, error: null };
          }
          return { data: state.settings.get(String(filters.tenant_key)) ?? null, error: null };
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

async function loadSettingsRoute() {
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
  return import('@/app/api/rag/admin/feedback-loop/tenant-settings/route');
}

function req(method: string, query = '', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/rag/admin/feedback-loop/tenant-settings${query}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  state = { session: null, authThrows: false, lookupFails: false, settings: new Map(), dataCalls: [] };
  silenceConsole();
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('tenant-settings route (D-06)', () => {
  it('runs the admin guard before anything is read: 401 without a credential or with a forged cookie, 403 for a non-admin, 503 when the guard is unavailable', async () => {
    const route = await loadSettingsRoute();
    const body = { tenantKey: TENANT, retrievalLog: 'off' };
    for (const call of [() => route.GET(req('GET', `?tenantKey=${TENANT}`)), () => route.PUT(req('PUT', '', body))]) {
      state.session = null;
      state.authThrows = false;
      state.lookupFails = false;
      expect((await call()).status).toBe(401);
      expect((await route.GET(req('GET', `?tenantKey=${TENANT}`, undefined, { cookie: 'admin_session=forged-value' }))).status).toBe(401);
      expect((await route.PUT(req('PUT', '', body, { cookie: 'admin_session=forged-value' }))).status).toBe(401);
      state.session = { id: USER_ID };
      expect((await call()).status).toBe(403);
      state.session = { id: ADMIN_ID };
      state.lookupFails = true;
      expect((await call()).status).toBe(503);
      state.session = null;
      state.lookupFails = false;
      state.authThrows = true;
      expect((await call()).status).toBe(503);
    }
    expect(state.dataCalls).toEqual([]);
    expect(state.settings.size).toBe(0);
  });

  it('an admin PUT stores the row with updated_by and returns it; GET reads it back', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadSettingsRoute();
    const response = await route.PUT(req('PUT', '', { tenantKey: TENANT, retrievalLog: 'ids' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await response.json();
    expect(json.settings).toMatchObject({ tenant_key: TENANT, retrieval_log: 'ids', updated_by: ADMIN_ID });
    expect(state.settings.get(TENANT)).toMatchObject({ retrieval_log: 'ids', updated_by: ADMIN_ID });

    const read = await route.GET(req('GET', `?tenantKey=${TENANT.toUpperCase()}`));
    expect(read.status).toBe(200);
    expect((await read.json()).settings).toMatchObject({ tenant_key: TENANT, retrieval_log: 'ids' });
  });

  it('GET for a tenant without a row answers inherit', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadSettingsRoute();
    const read = await route.GET(req('GET', `?tenantKey=${TENANT}`));
    expect(read.status).toBe(200);
    expect((await read.json()).settings).toMatchObject({ tenant_key: TENANT, retrieval_log: 'inherit', updated_by: null });
  });

  it('answers 400 for an invalid tenant key, level, extra field or a key of the other deployment mode, and writes nothing', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadSettingsRoute();
    const bodies: unknown[] = [
      { tenantKey: 'o:not-a-uuid', retrievalLog: 'ids' },
      { tenantKey: TENANT, retrievalLog: 'masked_query' },
      { tenantKey: TENANT, retrievalLog: 'ids', updated_by: USER_ID },
      { tenantKey: 's:default', retrievalLog: 'off' },
      { retrievalLog: 'off' },
    ];
    for (const body of bodies) {
      const response = await route.PUT(req('PUT', '', body));
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    const broken = await route.PUT(
      new NextRequest('http://localhost/api/rag/admin/feedback-loop/tenant-settings', { method: 'PUT', body: '{not json' }),
    );
    expect(broken.status).toBe(400);
    expect((await route.GET(req('GET', '?tenantKey=o:not-a-uuid'))).status).toBe(400);
    expect((await route.GET(req('GET'))).status).toBe(400);
    expect(state.settings.size).toBe(0);
  });

  it('single-tenant mode accepts only s:default', async () => {
    vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'single-tenant');
    state.session = { id: ADMIN_ID };
    const route = await loadSettingsRoute();
    expect((await route.PUT(req('PUT', '', { tenantKey: TENANT, retrievalLog: 'off' }))).status).toBe(400);
    const ok = await route.PUT(req('PUT', '', { tenantKey: 's:default', retrievalLog: 'off' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).settings).toMatchObject({ tenant_key: 's:default', retrieval_log: 'off' });
  });
});

async function loadPurgeRoute() {
  await loadSettingsRoute();
  return import('@/app/api/rag/admin/feedback-loop/purge/route');
}

function purgeReq(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/rag/admin/feedback-loop/purge', { method: 'POST', headers });
}

describe('purge route (D-06)', () => {
  it('runs the admin guard first: 401, forged cookie 401, 403, 503, and calls nothing before it', async () => {
    const route = await loadPurgeRoute();
    expect((await route.POST(purgeReq())).status).toBe(401);
    expect((await route.POST(purgeReq({ cookie: 'admin_session=forged-value' }))).status).toBe(401);
    state.session = { id: USER_ID };
    expect((await route.POST(purgeReq())).status).toBe(403);
    state.session = { id: ADMIN_ID };
    state.lookupFails = true;
    expect((await route.POST(purgeReq())).status).toBe(503);
    state.session = null;
    state.lookupFails = false;
    state.authThrows = true;
    expect((await route.POST(purgeReq())).status).toBe(503);
    expect(state.dataCalls).toEqual([]);
  });

  it('an admin POST purges with RAG_RETRIEVAL_LOG_RETENTION_DAYS and returns the counts', async () => {
    vi.stubEnv('RAG_RETRIEVAL_LOG_RETENTION_DAYS', '21');
    state.session = { id: ADMIN_ID };
    const route = await loadPurgeRoute();
    const response = await route.POST(purgeReq());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, retentionDays: 21, logRows: 0, reviewItems: 0 });
    expect(state.dataCalls).toEqual(['rpc:rag_purge_retrieval_log', 'rag_review_items']);
  });
});
