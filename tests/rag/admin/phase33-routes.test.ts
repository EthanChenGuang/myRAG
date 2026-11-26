import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000051a1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000051a2';
const MEMBER_ID = '00000000-0000-4000-8000-0000000051b1';
const ORG_O = '00000000-0000-4000-8000-0000000051c1';
const ORG_P = '00000000-0000-4000-8000-0000000051c2';
const SET_ID = '00000000-0000-4000-8000-0000000051d1';
const RULE_ID = '00000000-0000-4000-8000-0000000051e1';
const MARKER = 'QZXMARKERWORD';
const SECRET = 'placeholder-secret-0000';

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string; details?: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  env: {} as Record<string, string>,
  session: null as { id: string } | null,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
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
      const result = run();
      return Promise.resolve({ data: result.data[0] ?? null, error: null });
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
      const outcome = state.outcomes[fn] ?? { data: [], error: null };
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
  const sectionRules = await import('@/app/api/rag/admin/section-rules/route');
  const boilerplateRules = await import('@/app/api/rag/admin/boilerplate-rules/route');
  const attributeSchema = await import('@/app/api/rag/admin/attribute-schema/route');
  return { sectionRules, boilerplateRules, attributeSchema };
}

function req(url: string, init: { method?: string; body?: unknown; rawBody?: string } = {}) {
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body } : {}),
  });
}

const RULE_SET = {
  name: 'set-a',
  enabled: true,
  headings: [{ pattern: '^\\d+\\.', flags: 'u', name: 'level one', level: 1, required: false, restart: false }],
  require_increasing_numbers: false,
  skip_toc: true,
  toc_min_run: 3,
};

const SET_ROW = {
  id: SET_ID,
  tenant_key: 's:default',
  created_by: ADMIN_ID,
  name: 'set-a',
  doc_type: null,
  source: null,
  enabled: true,
  rules: { headings: RULE_SET.headings, require_increasing_numbers: false, skip_toc: true, toc_min_run: 3 },
  version: 1,
  created_at: '2026-11-26T10:00:00.000Z',
  updated_at: '2026-11-26T10:00:00.000Z',
};

const SET_JSON = {
  id: SET_ID,
  name: 'set-a',
  doc_type: null,
  source: null,
  enabled: true,
  version: 1,
  headings: RULE_SET.headings,
  require_increasing_numbers: false,
  skip_toc: true,
  toc_min_run: 3,
  updated_at: '2026-11-26T10:00:00.000Z',
};

const LINE_RULE = { name: 'rule-a', kind: 'line', pattern: '^-{3,}$', flags: 'u', enabled: true };
const RULE_ROW = {
  id: RULE_ID,
  tenant_key: 's:default',
  created_by: ADMIN_ID,
  name: 'rule-a',
  kind: 'line',
  pattern: '^-{3,}$',
  flags: 'u',
  max_length: null,
  min_page_share: null,
  doc_type: null,
  source: null,
  enabled: true,
  version: 1,
  created_at: '2026-11-26T10:00:00.000Z',
  updated_at: '2026-11-26T10:00:00.000Z',
};
const RULE_JSON = {
  id: RULE_ID,
  name: 'rule-a',
  kind: 'line',
  pattern: '^-{3,}$',
  flags: 'u',
  max_length: null,
  min_page_share: null,
  doc_type: null,
  source: null,
  enabled: true,
  version: 1,
  updated_at: '2026-11-26T10:00:00.000Z',
};

const DEF_ROW = {
  key: 'alpha_code',
  type: 'code',
  filterable: true,
  in_header: false,
  in_identifier_index: true,
  soft: false,
  updated_at: '2026-11-26T10:00:00.000Z',
};
const DEF_JSON = { ...DEF_ROW };

const ruleCalls = () => state.rpcCalls.filter((call) => /^rag_(section_rule|boilerplate_rule|attribute_definition)/.test(call.fn));

function resetState() {
  state.mode = 'single-tenant';
  state.env = {
    RAG_INGEST_PIPELINE: 'unified',
    RAG_SECTION_RULES: 'on',
    RAG_PAGE_BOILERPLATE: 'rules',
    RAG_DOC_ATTRIBUTES: 'true',
    RAG_SUPPORTED_LANGUAGES: 'en',
    RAG_PRIMARY_LANGUAGE: 'en',
  };
  state.session = null;
  state.rpcCalls = [];
  state.sessionLookups = 0;
  state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [] };
  state.outcomes = {
    rag_section_rule_sets_list: { data: [SET_ROW], error: null },
    rag_section_rule_set_upsert: { data: [SET_ROW], error: null },
    rag_section_rule_set_delete: { data: SET_ID, error: null },
    rag_boilerplate_rules_list: { data: [RULE_ROW], error: null },
    rag_boilerplate_rule_upsert: { data: [RULE_ROW], error: null },
    rag_boilerplate_rule_delete: { data: RULE_ID, error: null },
    rag_attribute_definitions_list: { data: [DEF_ROW], error: null },
    rag_attribute_definition_upsert: { data: [DEF_ROW], error: null },
    rag_attribute_definition_delete: { data: 'alpha_code', error: null },
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

describe('section-rules route', () => {
  it.each([
    ['unset', { RAG_SECTION_RULES: undefined }],
    ['off', { RAG_SECTION_RULES: 'off' }],
    ['on under the legacy pipeline', { RAG_INGEST_PIPELINE: 'legacy' }],
  ])('answers 404 with no session lookup and no rpc while the switch is %s', async (_label, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state.env[key];
      else state.env[key] = value;
    }
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const answers = [
      await loaded.sectionRules.GET(req('/api/rag/admin/section-rules')),
      await loaded.sectionRules.POST(req('/api/rag/admin/section-rules', { method: 'POST', body: { rule_set: RULE_SET } })),
      await loaded.sectionRules.PUT(req('/api/rag/admin/section-rules', { method: 'PUT', body: { id: SET_ID, rule_set: RULE_SET } })),
      await loaded.sectionRules.DELETE(req(`/api/rag/admin/section-rules?id=${SET_ID}`, { method: 'DELETE' })),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(await answer.json()).toEqual({ success: false, error: 'Not found' });
    }
    expect(state.sessionLookups).toBe(0);
    expect(state.rpcCalls).toEqual([]);
  });

  it('denies a request without a session and a member who is not an admin', async () => {
    const loaded = await load();
    const anonymous = await loaded.sectionRules.GET(req('/api/rag/admin/section-rules'));
    expect([401, 403]).toContain(anonymous.status);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
    state.session = { id: MEMBER_ID };
    expect((await loaded.sectionRules.GET(req('/api/rag/admin/section-rules'))).status).toBe(403);
    expect(ruleCalls()).toEqual([]);
  });

  it('lists the rule sets of the workspace as an allow-list without tenant key or actor', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const answer = await loaded.sectionRules.GET(req(`/api/rag/admin/section-rules?organizationId=${ORG_P}`));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual({ success: true, items: [SET_JSON] });
    expect(ruleCalls()).toEqual([{ fn: 'rag_section_rule_sets_list', args: { p_actor: ADMIN_ID, p_tenant_key: 's:default' } }]);
  });

  it('creates with 201, replaces with the raised version and deletes by id', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const created = await loaded.sectionRules.POST(req('/api/rag/admin/section-rules', { method: 'POST', body: { rule_set: RULE_SET } }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ success: true, item: SET_JSON });

    state.outcomes.rag_section_rule_set_upsert = { data: [{ ...SET_ROW, version: 2 }], error: null };
    const replaced = await loaded.sectionRules.PUT(req('/api/rag/admin/section-rules', { method: 'PUT', body: { id: SET_ID, rule_set: RULE_SET } }));
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ success: true, item: { ...SET_JSON, version: 2 } });

    const removed = await loaded.sectionRules.DELETE(req(`/api/rag/admin/section-rules?id=${SET_ID}`, { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true, id: SET_ID });

    expect(ruleCalls().map((call) => [call.fn, call.args.p_tenant_key, call.args.p_actor, call.args.p_id])).toEqual([
      ['rag_section_rule_set_upsert', 's:default', ADMIN_ID, null],
      ['rag_section_rule_set_upsert', 's:default', ADMIN_ID, SET_ID],
      ['rag_section_rule_set_delete', 's:default', ADMIN_ID, SET_ID],
    ]);
    expect(logged.some((line) => line.startsWith('[RAG Admin]'))).toBe(true);
  });

  it('refuses a body naming a tenant key, a tenant id or an actor, invalid JSON, a non-uuid id and a 61st heading pattern', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const extra of [{ tenant_key: 'o:x' }, { tenant_id: ORG_P }, { actor: MEMBER_ID }]) {
      const answer = await loaded.sectionRules.POST(req('/api/rag/admin/section-rules', { method: 'POST', body: { rule_set: RULE_SET, ...extra } }));
      expect(answer.status).toBe(400);
      expect((await answer.json()).error).toBe('Invalid request data');
    }
    const inner = await loaded.sectionRules.POST(
      req('/api/rag/admin/section-rules', { method: 'POST', body: { rule_set: { ...RULE_SET, tenant_key: 's:default' } } }),
    );
    expect(inner.status).toBe(400);

    const notJson = await loaded.sectionRules.POST(req('/api/rag/admin/section-rules', { method: 'POST', rawBody: '{' }));
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).details).toEqual([{ path: '', message: 'Body is not valid JSON' }]);

    const badId = await loaded.sectionRules.PUT(req('/api/rag/admin/section-rules', { method: 'PUT', body: { id: 'nope', rule_set: RULE_SET } }));
    expect(badId.status).toBe(400);
    expect((await badId.json()).details.map((d: { path: string }) => d.path)).toContain('id');
    const badDelete = await loaded.sectionRules.DELETE(req('/api/rag/admin/section-rules?id=nope', { method: 'DELETE' }));
    expect(badDelete.status).toBe(400);
    expect((await badDelete.json()).details.map((d: { path: string }) => d.path)).toContain('id');

    const many = Array.from({ length: 61 }, (_, i) => ({ ...RULE_SET.headings[0], name: `h${i}`, pattern: `^${i}\\.` }));
    const tooMany = await loaded.sectionRules.POST(req('/api/rag/admin/section-rules', { method: 'POST', body: { rule_set: { ...RULE_SET, headings: many } } }));
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toBe('Invalid request data');
    expect(ruleCalls()).toEqual([]);
  });

  it('refuses an unanchored heading pattern with its finding code, without an upsert and without echoing the pattern', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const headings = [RULE_SET.headings[0], { ...RULE_SET.headings[0], name: 'level two', pattern: `${MARKER}\\d+` }];
    const answer = await loaded.sectionRules.POST(req('/api/rag/admin/section-rules', { method: 'POST', body: { rule_set: { ...RULE_SET, headings } } }));
    expect(answer.status).toBe(400);
    const text = await answer.text();
    expect(JSON.parse(text)).toEqual({
      success: false,
      error: 'invalid_tenant_pattern',
      details: [{ path: 'rule_set.headings.1.pattern', message: 'heading_not_anchored' }],
    });
    expect(text).not.toContain(MARKER);
    expect(logged.join('\n')).not.toContain(MARKER);
    expect(ruleCalls().filter((call) => call.fn.endsWith('_upsert'))).toEqual([]);
  });

  it.each([
    ['limit_reached', { code: '54000', message: 'limit_reached', details: 'rule_sets' }, 409, { success: false, error: 'limit_reached', limit: 'rule_sets' }],
    ['name_exists', { code: '23505', message: 'name_exists' }, 409, { success: false, error: 'name_exists' }],
    ['not_found', { code: 'P0002', message: 'not_found' }, 404, { success: false, error: 'not_found' }],
    ['not_admin', { code: '42501', message: 'not_admin' }, 403, { success: false, error: 'Forbidden' }],
    ['invalid_argument', { code: '22023', message: 'invalid_argument', details: 'name' }, 400, { success: false, error: 'Invalid request' }],
  ])('maps %s to its fixed answer', async (_word, error, status, body) => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_section_rule_set_upsert = { data: null, error };
    const answer = await loaded.sectionRules.PUT(req('/api/rag/admin/section-rules', { method: 'PUT', body: { id: SET_ID, rule_set: RULE_SET } }));
    expect(answer.status).toBe(status);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(await answer.json()).toEqual(body);
  });

  it('answers 503 for a database failure and never shows its message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_section_rule_sets_list = { data: null, error: { code: 'XX000', message: `connection failed ${SECRET}` } };
    const answer = await loaded.sectionRules.GET(req('/api/rag/admin/section-rules'));
    expect(answer.status).toBe(503);
    const text = await answer.text();
    expect(text).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);
  });

  it('answers an unknown and a foreign id with the same 404 body', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_section_rule_set_delete = { data: null, error: { code: 'P0002', message: 'not_found' } };
    const first = await loaded.sectionRules.DELETE(req(`/api/rag/admin/section-rules?id=${SET_ID}`, { method: 'DELETE' }));
    const second = await loaded.sectionRules.DELETE(req(`/api/rag/admin/section-rules?id=${RULE_ID}`, { method: 'DELETE' }));
    expect(first.status).toBe(404);
    expect(await first.json()).toEqual(await second.json());
  });

  describe('multi-tenant', () => {
    beforeEach(() => {
      state.mode = 'multi-tenant';
      state.tables.organization_members = [
        { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
        { organization_id: ORG_O, user_id: MEMBER_ID, role: 'member' },
        { organization_id: ORG_P, user_id: ADMIN_ID, role: 'owner' },
      ];
    });

    it("binds O's admin to o:<O>, refuses P with 403 and no rpc, and admits the deployment admin for P", async () => {
      const loaded = await load();
      state.session = { id: ORG_ADMIN_ID };
      expect((await loaded.sectionRules.GET(req(`/api/rag/admin/section-rules?organizationId=${ORG_O}`))).status).toBe(200);
      expect(ruleCalls()).toEqual([{ fn: 'rag_section_rule_sets_list', args: { p_actor: ORG_ADMIN_ID, p_tenant_key: `o:${ORG_O}` } }]);

      state.rpcCalls = [];
      const foreign = await loaded.sectionRules.POST(req(`/api/rag/admin/section-rules?organizationId=${ORG_P}`, { method: 'POST', body: { rule_set: RULE_SET } }));
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get('cache-control')).toBe('no-store');
      expect(ruleCalls()).toEqual([]);

      state.session = { id: MEMBER_ID };
      expect((await loaded.sectionRules.GET(req(`/api/rag/admin/section-rules?organizationId=${ORG_O}`))).status).toBe(403);
      expect(ruleCalls()).toEqual([]);

      state.session = { id: ADMIN_ID };
      expect((await loaded.sectionRules.GET(req(`/api/rag/admin/section-rules?organizationId=${ORG_P}`))).status).toBe(200);
      expect(ruleCalls()).toEqual([{ fn: 'rag_section_rule_sets_list', args: { p_actor: ADMIN_ID, p_tenant_key: `o:${ORG_P}` } }]);
    });
  });
});

describe('boilerplate-rules route', () => {
  it.each([
    ['unset', { RAG_PAGE_BOILERPLATE: undefined }],
    ['off', { RAG_PAGE_BOILERPLATE: 'off' }],
    ['on under the legacy pipeline', { RAG_INGEST_PIPELINE: 'legacy' }],
  ])('answers 404 with no session lookup and no rpc while the switch is %s', async (_label, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state.env[key];
      else state.env[key] = value;
    }
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const answers = [
      await loaded.boilerplateRules.GET(req('/api/rag/admin/boilerplate-rules')),
      await loaded.boilerplateRules.POST(req('/api/rag/admin/boilerplate-rules', { method: 'POST', body: { rule: LINE_RULE } })),
      await loaded.boilerplateRules.PUT(req('/api/rag/admin/boilerplate-rules', { method: 'PUT', body: { id: RULE_ID, rule: LINE_RULE } })),
      await loaded.boilerplateRules.DELETE(req(`/api/rag/admin/boilerplate-rules?id=${RULE_ID}`, { method: 'DELETE' })),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.sessionLookups).toBe(0);
    expect(state.rpcCalls).toEqual([]);
  });

  it('lists, creates, replaces and deletes rules of the workspace', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const listed = await loaded.boilerplateRules.GET(req('/api/rag/admin/boilerplate-rules'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ success: true, items: [RULE_JSON] });
    const created = await loaded.boilerplateRules.POST(req('/api/rag/admin/boilerplate-rules', { method: 'POST', body: { rule: LINE_RULE } }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ success: true, item: RULE_JSON });
    state.outcomes.rag_boilerplate_rule_upsert = { data: [{ ...RULE_ROW, version: 2 }], error: null };
    const replaced = await loaded.boilerplateRules.PUT(req('/api/rag/admin/boilerplate-rules', { method: 'PUT', body: { id: RULE_ID, rule: LINE_RULE } }));
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).item.version).toBe(2);
    const removed = await loaded.boilerplateRules.DELETE(req(`/api/rag/admin/boilerplate-rules?id=${RULE_ID}`, { method: 'DELETE' }));
    expect(await removed.json()).toEqual({ success: true, id: RULE_ID });
    expect(ruleCalls().every((call) => call.args.p_tenant_key === 's:default' && call.args.p_actor === ADMIN_ID)).toBe(true);
  });

  it('refuses a refused line pattern with path rule.pattern and a fragment or line rule of the wrong shape', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const refused = await loaded.boilerplateRules.POST(
      req('/api/rag/admin/boilerplate-rules', { method: 'POST', body: { rule: { ...LINE_RULE, pattern: `(${MARKER}` } } }),
    );
    expect(refused.status).toBe(400);
    const text = await refused.text();
    const body = JSON.parse(text);
    expect(body.error).toBe('invalid_tenant_pattern');
    expect(body.details.length).toBeGreaterThan(0);
    for (const detail of body.details) expect(detail.path).toBe('rule.pattern');
    expect(text).not.toContain(MARKER);
    expect(logged.join('\n')).not.toContain(MARKER);

    const fragmentWithPattern = await loaded.boilerplateRules.POST(
      req('/api/rag/admin/boilerplate-rules', {
        method: 'POST',
        body: { rule: { name: 'rule-b', kind: 'fragment', pattern: '^-+$', max_length: 40, min_page_share: 0.5 } },
      }),
    );
    expect(fragmentWithPattern.status).toBe(400);
    expect((await fragmentWithPattern.json()).error).toBe('Invalid request data');
    const lineWithout = await loaded.boilerplateRules.POST(req('/api/rag/admin/boilerplate-rules', { method: 'POST', body: { rule: { name: 'rule-c', kind: 'line' } } }));
    expect(lineWithout.status).toBe(400);
    expect((await lineWithout.json()).error).toBe('Invalid request data');
    expect(ruleCalls().filter((call) => call.fn.endsWith('_upsert'))).toEqual([]);
  });
});

describe('attribute-schema route', () => {
  it.each([
    ['unset', { RAG_DOC_ATTRIBUTES: undefined }],
    ['false', { RAG_DOC_ATTRIBUTES: 'false' }],
    ['true under the legacy pipeline', { RAG_INGEST_PIPELINE: 'legacy' }],
  ])('answers 404 with no session lookup and no rpc while the switch is %s', async (_label, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state.env[key];
      else state.env[key] = value;
    }
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const answers = [
      await loaded.attributeSchema.GET(req('/api/rag/admin/attribute-schema')),
      await loaded.attributeSchema.PUT(req('/api/rag/admin/attribute-schema', { method: 'PUT', body: { definition: { key: 'alpha_code', type: 'code' } } })),
      await loaded.attributeSchema.DELETE(req('/api/rag/admin/attribute-schema?key=alpha_code', { method: 'DELETE' })),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.sessionLookups).toBe(0);
    expect(state.rpcCalls).toEqual([]);
  });

  it('gates each route by its own switch', async () => {
    state.env.RAG_SECTION_RULES = 'off';
    state.env.RAG_PAGE_BOILERPLATE = 'off';
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await loaded.sectionRules.GET(req('/api/rag/admin/section-rules'))).status).toBe(404);
    expect((await loaded.boilerplateRules.GET(req('/api/rag/admin/boilerplate-rules'))).status).toBe(404);
    expect((await loaded.attributeSchema.GET(req('/api/rag/admin/attribute-schema'))).status).toBe(200);
  });

  it('lists, upserts and deletes definitions of the workspace', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const listed = await loaded.attributeSchema.GET(req('/api/rag/admin/attribute-schema'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ success: true, items: [DEF_JSON] });
    const upserted = await loaded.attributeSchema.PUT(
      req('/api/rag/admin/attribute-schema', { method: 'PUT', body: { definition: { key: 'alpha_code', type: 'code', filterable: true, in_identifier_index: true } } }),
    );
    expect(upserted.status).toBe(200);
    expect(await upserted.json()).toEqual({ success: true, item: DEF_JSON });
    const removed = await loaded.attributeSchema.DELETE(req('/api/rag/admin/attribute-schema?key=alpha_code', { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true, key: 'alpha_code' });
    expect(ruleCalls().map((call) => [call.fn, call.args.p_tenant_key, call.args.p_actor])).toEqual([
      ['rag_attribute_definitions_list', 's:default', ADMIN_ID],
      ['rag_attribute_definition_upsert', 's:default', ADMIN_ID],
      ['rag_attribute_definition_delete', 's:default', ADMIN_ID],
    ]);
  });

  it('refuses the identifier index on a text key, a bad key and a tenant field before any rpc', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const textIndex = await loaded.attributeSchema.PUT(
      req('/api/rag/admin/attribute-schema', { method: 'PUT', body: { definition: { key: 'alpha_text', type: 'text', in_identifier_index: true } } }),
    );
    expect(textIndex.status).toBe(400);
    expect((await textIndex.json()).error).toBe('Invalid request data');
    const tenant = await loaded.attributeSchema.PUT(
      req('/api/rag/admin/attribute-schema', { method: 'PUT', body: { definition: { key: 'alpha_code', type: 'code' }, tenant_key: 's:default' } }),
    );
    expect(tenant.status).toBe(400);
    const badKey = await loaded.attributeSchema.DELETE(req('/api/rag/admin/attribute-schema?key=Bad-Key', { method: 'DELETE' }));
    expect(badKey.status).toBe(400);
    expect((await badKey.json()).details.map((d: { path: string }) => d.path)).toContain('key');
    expect(ruleCalls()).toEqual([]);
  });

  it.each([
    ['a type change', 'rag_attribute_definition_upsert', { code: '22023', message: 'invalid_attribute_type' }, 400, 'invalid_attribute_type'],
    ['the 31st key', 'rag_attribute_definition_upsert', { code: '54000', message: 'limit_reached' }, 409, 'limit_reached'],
    ['turning in_header off for a template key', 'rag_attribute_definition_upsert', { code: '2BP01', message: 'unknown_placeholder' }, 409, 'unknown_placeholder'],
    ['deleting a template key', 'rag_attribute_definition_delete', { code: '2BP01', message: 'unknown_placeholder' }, 409, 'unknown_placeholder'],
    ['an unknown key', 'rag_attribute_definition_delete', { code: 'P0002', message: 'not_found' }, 404, 'not_found'],
  ])('maps %s to its fixed answer', async (_label, fn, error, status, word) => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes[fn] = { data: null, error };
    const answer = fn.endsWith('_delete')
      ? await loaded.attributeSchema.DELETE(req('/api/rag/admin/attribute-schema?key=alpha_code', { method: 'DELETE' }))
      : await loaded.attributeSchema.PUT(req('/api/rag/admin/attribute-schema', { method: 'PUT', body: { definition: { key: 'alpha_code', type: 'text' } } }));
    expect(answer.status).toBe(status);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect((await answer.json()).error).toBe(word);
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

  it("never lets O's admin read or change P's rules or definitions; every rpc carries the admitted key", async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const foreign = [
      await loaded.boilerplateRules.GET(req(`/api/rag/admin/boilerplate-rules?organizationId=${ORG_P}`)),
      await loaded.boilerplateRules.DELETE(req(`/api/rag/admin/boilerplate-rules?id=${RULE_ID}&organizationId=${ORG_P}`, { method: 'DELETE' })),
      await loaded.attributeSchema.GET(req(`/api/rag/admin/attribute-schema?organizationId=${ORG_P}`)),
      await loaded.attributeSchema.PUT(
        req(`/api/rag/admin/attribute-schema?organizationId=${ORG_P}`, { method: 'PUT', body: { definition: { key: 'alpha_code', type: 'code' } } }),
      ),
      await loaded.sectionRules.DELETE(req(`/api/rag/admin/section-rules?id=${SET_ID}&organizationId=${ORG_P}`, { method: 'DELETE' })),
    ];
    for (const answer of foreign) {
      expect(answer.status).toBe(403);
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(ruleCalls()).toEqual([]);

    await loaded.boilerplateRules.GET(req(`/api/rag/admin/boilerplate-rules?organizationId=${ORG_O}`));
    await loaded.attributeSchema.DELETE(req(`/api/rag/admin/attribute-schema?key=alpha_code&organizationId=${ORG_O}`, { method: 'DELETE' }));
    state.session = { id: MEMBER_ID };
    await loaded.attributeSchema.GET(req(`/api/rag/admin/attribute-schema?organizationId=${ORG_P}`));
    expect(ruleCalls().map((call) => [call.args.p_tenant_key, call.args.p_actor])).toEqual([
      [`o:${ORG_O}`, ORG_ADMIN_ID],
      [`o:${ORG_O}`, ORG_ADMIN_ID],
      [`o:${ORG_P}`, MEMBER_ID],
    ]);
  });
});
