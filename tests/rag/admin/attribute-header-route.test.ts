import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TPL-05 / TPL-08 (D-26, D-34): the admin route of the tenant attribute header template. Admin-only, tenant key from the admission only,
 * 404 while RAG_ATTRIBUTE_HEADER is effectively off, no-store on every answer. Templates and keys are synthetic.
 */

const ADMIN_ID = '00000000-0000-4000-8000-0000000052a1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000052a2';
const MEMBER_ID = '00000000-0000-4000-8000-0000000052b1';
const ORG_O = '00000000-0000-4000-8000-0000000052c1';
const ORG_P = '00000000-0000-4000-8000-0000000052c2';
const SECRET = 'placeholder-secret-0001';
const TEMPLATE = 'A {alpha_code} | B {beta_list}';
const ROUTE = '/api/rag/admin/attribute-header';

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  env: {} as Record<string, string>,
  session: null as { id: string } | null,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome | ((args: Record<string, unknown>) => RpcOutcome)>,
  sessionLookups: 0,
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let limit = Infinity;
  const run = () => ({ data: (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(0, limit), error: null });
  const builder = {
    select: () => builder,
    abortSignal: () => builder,
    order: () => builder,
    limit(value: number) {
      limit = value;
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      filters.push((row) => values.includes(row[column]));
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: run().data[0] ?? null, error: null });
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve(run()).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function fakeClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }),
      admin: { getUserById: async () => ({ data: { user: null }, error: { message: 'not found' } }) },
    },
    from: (table: string) => query(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const configured = state.outcomes[fn];
      const outcome = typeof configured === 'function' ? configured(args) : (configured ?? { data: [], error: null });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function load() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = state.mode;
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          state.sessionLookups += 1;
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => fakeClient() as never, ingestEnv: () => ({ ...state.env }) as never });
  const header = await import('@/lib/rag/ingest/attributes/header');
  header.resetHeaderTemplateCacheForTests();
  return import('@/app/api/rag/admin/attribute-header/route');
}

function req(url: string, init: { method?: string; body?: unknown; rawBody?: string } = {}) {
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  });
}

const defRow = (key: string, type: string, inHeader: boolean) => ({
  key,
  type,
  filterable: false,
  in_header: inHeader,
  in_identifier_index: false,
  soft: false,
  updated_at: '2026-11-26T10:00:00.000Z',
});

const headerCalls = () => state.rpcCalls.filter((call) => /^rag_attribute_(header|definitions)/.test(call.fn));

function resetState() {
  state.mode = 'single-tenant';
  state.env = {
    RAG_INGEST_PIPELINE: 'unified',
    RAG_DOC_ATTRIBUTES: 'true',
    RAG_ATTRIBUTE_HEADER: 'true',
    RAG_SUPPORTED_LANGUAGES: 'en',
    RAG_PRIMARY_LANGUAGE: 'en',
  };
  state.session = null;
  state.rpcCalls = [];
  state.sessionLookups = 0;
  state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [] };
  state.outcomes = {
    rag_attribute_definitions_list: { data: [defRow('alpha_code', 'code', true), defRow('beta_list', 'text_list', true), defRow('gamma_text', 'text', false)], error: null },
    rag_attribute_header_template_get: { data: [{ template: TEMPLATE, version: 3, updated_at: '2026-11-26T10:00:00.000Z' }], error: null },
    rag_attribute_header_template_for: { data: [{ template: TEMPLATE, version: 3 }], error: null },
    rag_attribute_header_template_set: (args) => ({ data: args.p_template === null ? [] : [{ template: args.p_template, version: 4, updated_at: '2026-11-26T10:00:00.000Z' }], error: null }),
    rag_attribute_header_stale: { data: [{ document_id: ADMIN_ID, doc_type: 'general', stamp: null, stale_chunks: 1 }], error: null },
    rag_attribute_header_pending: { data: [], error: null },
    rag_set_document_attribute_headers: { data: [{ updated: 0, unchanged: 0 }], error: null },
  };
}

let logged: string[];

beforeEach(() => {
  resetState();
  logged = [];
  for (const method of ['warn', 'error', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
});

describe('attribute-header route', () => {
  it.each([
    ['unset', { RAG_ATTRIBUTE_HEADER: undefined }],
    ['false', { RAG_ATTRIBUTE_HEADER: 'false' }],
    ['on without RAG_DOC_ATTRIBUTES', { RAG_DOC_ATTRIBUTES: 'false' }],
    ['on under the legacy pipeline', { RAG_INGEST_PIPELINE: 'legacy' }],
  ])('answers 404 with no session lookup and no rpc while the switch is %s', async (_label, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state.env[key];
      else state.env[key] = value;
    }
    const route = await load();
    state.session = { id: ADMIN_ID };
    const answers = [
      await route.GET(req(ROUTE)),
      await route.PUT(req(ROUTE, { method: 'PUT', body: { template: TEMPLATE } })),
      await route.POST(req(ROUTE, { method: 'POST', body: { action: 'render' } })),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ success: false, error: 'Not found' });
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.sessionLookups).toBe(0);
    expect(state.rpcCalls).toEqual([]);
  });

  it('no session or a non-admin gets the admin denial and no rpc', async () => {
    const route = await load();
    const anonymous = await route.GET(req(ROUTE));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    state.session = { id: MEMBER_ID };
    const member = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: TEMPLATE } }));
    expect(member.status).toBe(403);
    expect(member.headers.get('cache-control')).toBe('no-store');
    expect(headerCalls()).toEqual([]);
  });

  it('GET answers the template, the in_header keys, the limit and the stale count', async () => {
    const route = await load();
    state.session = { id: ADMIN_ID };
    const answer = await route.GET(req(`${ROUTE}?organizationId=${ORG_O}`));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual({
      success: true,
      template: TEMPLATE,
      version: 3,
      placeholders: ['alpha_code', 'beta_list'],
      limits: { max_template_length: 200 },
      stale: { count: 1, more: false },
    });
    expect(headerCalls().every((call) => call.args.p_tenant_key === 's:default')).toBe(true);
  });

  it('GET without a saved template answers template null and version 0', async () => {
    state.outcomes.rag_attribute_header_template_get = { data: [], error: null };
    const route = await load();
    state.session = { id: ADMIN_ID };
    const body = await (await route.GET(req(ROUTE))).json();
    expect([body.template, body.version]).toEqual([null, 0]);
  });

  it('PUT saves, re-renders and reports; null removes', async () => {
    const route = await load();
    state.session = { id: ADMIN_ID };
    const saved = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: '{beta_list}' } }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ success: true, template: '{beta_list}', version: 4, rerendered: 0, more: false });
    const set = state.rpcCalls.find((call) => call.fn === 'rag_attribute_header_template_set');
    expect(set?.args).toEqual({ p_actor: ADMIN_ID, p_tenant_key: 's:default', p_template: '{beta_list}' });
    expect(state.rpcCalls.some((call) => call.fn === 'rag_attribute_header_pending' && call.args.p_tenant_key === 's:default')).toBe(true);
    const removed = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: null } }));
    expect(await removed.json()).toEqual({ success: true, template: null, version: 0, rerendered: 0, more: false });
  });

  it('PUT refuses 201 characters, extra fields and an unknown placeholder before the writer', async () => {
    const route = await load();
    state.session = { id: ADMIN_ID };
    const long = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: 'x'.repeat(201) } }));
    expect(long.status).toBe(400);
    expect((await long.json()).error).toBe('Invalid request data');
    const extra = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: TEMPLATE, tenant_key: 's:default' } }));
    expect(extra.status).toBe(400);
    expect((await extra.json()).error).toBe('Invalid request data');
    const bad = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: '{alpha_code} {gamma_text}' } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ success: false, error: 'unknown_placeholder', details: [{ path: 'template', message: 'gamma_text' }] });
    const json = await route.PUT(req(ROUTE, { method: 'PUT', rawBody: '{' }));
    expect(json.status).toBe(400);
    expect(state.rpcCalls.some((call) => call.fn === 'rag_attribute_header_template_set')).toBe(false);
  });

  it('POST render continues the re-render; another action is refused', async () => {
    state.outcomes.rag_attribute_header_pending = (args) => ({
      data: args.p_after === null ? [{ document_id: ADMIN_ID, attributes: { alpha_code: 'K-1' }, stamp: null }] : [],
      error: null,
    });
    state.outcomes.rag_set_document_attribute_headers = { data: [{ updated: 1, unchanged: 0 }], error: null };
    const route = await load();
    state.session = { id: ADMIN_ID };
    const answer = await route.POST(req(ROUTE, { method: 'POST', body: { action: 'render' } }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ success: true, rerendered: 1, more: false });
    const refused = await route.POST(req(ROUTE, { method: 'POST', body: { action: 'drop' } }));
    expect(refused.status).toBe(400);
  });

  it('a failing rpc with a secret in its message answers 503; neither the answer nor a log line holds the secret or the template', async () => {
    state.outcomes.rag_attribute_header_template_set = { data: null, error: { code: 'XX000', message: `connection failed ${SECRET}` } };
    state.outcomes.rag_attribute_header_template_get = { data: null, error: { code: 'XX000', message: `connection failed ${SECRET}` } };
    const route = await load();
    state.session = { id: ADMIN_ID };
    const put = await route.PUT(req(ROUTE, { method: 'PUT', body: { template: TEMPLATE } }));
    const get = await route.GET(req(ROUTE));
    for (const answer of [put, get]) {
      expect(answer.status).toBe(503);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      const text = await answer.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TEMPLATE);
    }
    expect(logged.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(TEMPLATE);
  });
});

describe('two organizations (multi-tenant)', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_P, user_id: MEMBER_ID, role: 'admin' },
    ];
  });

  it("never lets O's admin read or change P's template; every rpc carries the admitted key", async () => {
    const route = await load();
    state.session = { id: ORG_ADMIN_ID };
    const foreign = [
      await route.GET(req(`${ROUTE}?organizationId=${ORG_P}`)),
      await route.PUT(req(`${ROUTE}?organizationId=${ORG_P}`, { method: 'PUT', body: { template: TEMPLATE } })),
      await route.POST(req(`${ROUTE}?organizationId=${ORG_P}`, { method: 'POST', body: { action: 'render' } })),
    ];
    for (const answer of foreign) {
      expect(answer.status).toBe(403);
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(headerCalls()).toEqual([]);

    await route.PUT(req(`${ROUTE}?organizationId=${ORG_O}`, { method: 'PUT', body: { template: TEMPLATE } }));
    state.session = { id: MEMBER_ID };
    await route.GET(req(`${ROUTE}?organizationId=${ORG_P}`));
    const keys = [...new Set(headerCalls().map((call) => call.args.p_tenant_key))];
    expect(keys).toEqual([`o:${ORG_O}`, `o:${ORG_P}`]);
    const setCalls = state.rpcCalls.filter((call) => call.fn === 'rag_attribute_header_template_set');
    expect(setCalls.map((call) => [call.args.p_tenant_key, call.args.p_actor])).toEqual([[`o:${ORG_O}`, ORG_ADMIN_ID]]);
  });
});
