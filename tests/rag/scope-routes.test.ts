import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000041a1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000041a2';
const MEMBER_ID = '00000000-0000-4000-8000-0000000041b1';
const ORG_O = '00000000-0000-4000-8000-0000000041c1';
const ORG_P = '00000000-0000-4000-8000-0000000041c2';
const DOC_ID = '00000000-0000-4000-8000-0000000041d1';
const ENTRY_ID = '00000000-0000-4000-8000-0000000041e1';
const FILE_NAME = 'neutral-sample-report.pdf';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  scopeTags: 'true',
  pipeline: 'unified',
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
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
      getUser: async (token: string) => {
        const id = state.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
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
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({
    db: () => fakeClient() as never,
    ingestEnv: () => ({ RAG_SCOPE_TAGS: state.scopeTags, RAG_INGEST_PIPELINE: state.pipeline }),
  });
  const vocabulary = await import('@/app/api/rag/admin/scope-vocabulary/route');
  const documents = await import('@/app/api/rag/admin/documents/route');
  const scopes = await import('@/app/api/rag/admin/documents/[id]/scopes/route');
  return { vocabulary, documents, scopes };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; authorization?: string; body?: unknown; rawBody?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const ENTRY_ROW = {
  id: ENTRY_ID,
  tenant_key: 's:default',
  dimension: 'region',
  value: 'a1',
  label: 'Area one',
  aliases: ['First area'],
  active: true,
  created_at: '2026-11-24T10:00:00.000Z',
  updated_at: '2026-11-24T10:00:00.000Z',
};
const ENTRY_JSON = { id: ENTRY_ID, dimension: 'region', value: 'a1', label: 'Area one', aliases: ['First area'], active: true, updated_at: '2026-11-24T10:00:00.000Z' };

const scopeCalls = () => state.rpcCalls.filter((call) => /^rag_(scope_|set_document_scopes|list_documents_with_scopes)/.test(call.fn));

function resetState() {
  state.mode = 'single-tenant';
  state.scopeTags = 'true';
  state.pipeline = 'unified';
  state.session = null;
  state.tokens = {};
  state.rpcCalls = [];
  state.tables = {
    admin_users: [{ id: ADMIN_ID }],
    organization_members: [],
  };
  state.outcomes = {
    rag_scope_vocabulary_list: { data: [ENTRY_ROW], error: null },
    rag_scope_vocabulary_create: { data: [ENTRY_ROW], error: null },
    rag_scope_vocabulary_update: { data: [{ ...ENTRY_ROW, label: 'Area one renamed' }], error: null },
    rag_set_document_scopes: { data: [{ document_id: DOC_ID, scopes: ['region:a1'], chunks_updated: 2 }], error: null },
  };
}

describe('scope tag routes: create and tag', () => {
  let logged: string[];

  beforeEach(() => {
    resetState();
    logged = [];
    for (const method of ['warn', 'error', 'log', 'info'] as const) {
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

  it('creates a vocabulary value as the verified admin and answers the stored entry without the tenant key', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.vocabulary.POST(
      req('/api/rag/admin/scope-vocabulary', { method: 'POST', body: { dimension: 'region', value: 'a1', label: 'Area one', aliases: ['First area'] } }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, item: ENTRY_JSON });
    expect(scopeCalls()).toEqual([
      {
        fn: 'rag_scope_vocabulary_create',
        args: { p_actor: ADMIN_ID, p_tenant_key: 's:default', p_dimension: 'region', p_value: 'a1', p_label: 'Area one', p_aliases: ['First area'] },
      },
    ]);
  });

  it('lists the vocabulary of the workspace', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.vocabulary.GET(req('/api/rag/admin/scope-vocabulary'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, dimensions: ['region', 'legal_entity', 'department'], items: [ENTRY_JSON] });
    expect(scopeCalls()).toEqual([{ fn: 'rag_scope_vocabulary_list', args: { p_actor: ADMIN_ID, p_tenant_key: 's:default' } }]);
  });

  it('tags a document with the guard user as actor and answers the stored tags', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: ['region:a1'] } }), params(DOC_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, scopes: ['region:a1'] });
    expect(scopeCalls()).toEqual([
      { fn: 'rag_set_document_scopes', args: { p_document_id: DOC_ID, p_tenant_key: 's:default', p_scopes: ['region:a1'], p_actor: ADMIN_ID } },
    ]);
  });

  it('refuses an actor in the body and answers unknown_scope_value with 400', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const withActor = await loaded.scopes.PUT(
      req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: ['region:a1'], actor: MEMBER_ID } }),
      params(DOC_ID),
    );
    expect(withActor.status).toBe(400);
    expect(scopeCalls()).toEqual([]);

    state.outcomes.rag_set_document_scopes = { data: null, error: { code: 'P0001', message: 'unknown_scope_value' } };
    const unknown = await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: ['region:zz9'] } }), params(DOC_ID));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ success: false, error: 'unknown_scope_value' });
  });

  it('answers the same 404 for an unknown and a foreign document id, and 503 without the database message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_set_document_scopes = { data: null, error: { code: 'P0001', message: 'not_found' } };
    const missing = await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: [] } }), params(DOC_ID));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ success: false, error: 'Document not found' });

    state.outcomes.rag_set_document_scopes = { data: null, error: { code: 'XX000', message: 'connection lost to host db.internal' } };
    const down = await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: [] } }), params(DOC_ID));
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toContain('db.internal');
    expect(logged.join('\n')).not.toContain('db.internal');
  });

  it('fails closed: 401 without a credential, 403 to a non-admin, and no scope function runs', async () => {
    const loaded = await load();
    const calls = [
      () => loaded.vocabulary.GET(req('/api/rag/admin/scope-vocabulary')),
      () => loaded.vocabulary.POST(req('/api/rag/admin/scope-vocabulary', { method: 'POST', body: { dimension: 'region', value: 'a1', label: 'Area one' } })),
      () => loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: ['region:a1'] } }), params(DOC_ID)),
    ];
    for (const call of calls) expect((await call()).status).toBe(401);
    state.session = { id: MEMBER_ID };
    for (const call of calls) expect((await call()).status).toBe(403);
    expect(scopeCalls()).toEqual([]);
  });
});

describe('scope tag routes: vocabulary rules', () => {
  beforeEach(() => {
    resetState();
    for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  });

  const post = (loaded: Loaded, body: unknown) => loaded.vocabulary.POST(req('/api/rag/admin/scope-vocabulary', { method: 'POST', body }));
  const patch = (loaded: Loaded, body: unknown) => loaded.vocabulary.PATCH(req('/api/rag/admin/scope-vocabulary', { method: 'PATCH', body }));

  it('normalizes the value to a slug (case, spaces, repeated hyphens) before the database call', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await post(loaded, { dimension: 'region', value: ' Area--A1 ', label: 'Area one' })).status).toBe(201);
    expect(scopeCalls()[0]?.args.p_value).toBe('area-a1');
  });

  it('refuses a value with no slug characters with 400 invalid_value and calls nothing', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await post(loaded, { dimension: 'region', value: '中文', label: 'Area one' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'invalid_value' });
    expect(scopeCalls()).toEqual([]);
  });

  it('maps tag_exists to 409 and refuses a fourth dimension or an extra key with 400', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_scope_vocabulary_create = { data: null, error: { code: 'P0001', message: 'tag_exists' } };
    const duplicate = await post(loaded, { dimension: 'region', value: 'a1', label: 'Area one' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ success: false, error: 'tag_exists' });
    expect((await post(loaded, { dimension: 'country', value: 'a1', label: 'Area one' })).status).toBe(400);
    expect((await post(loaded, { dimension: 'region', value: 'a1', label: 'Area one', active: false, tenantKey: 's:default' })).status).toBe(400);
  });

  it('edits label, other names and the active flag of an entry; a changed value or dimension answers 400', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const ok = await patch(loaded, { id: ENTRY_ID, label: 'Area one renamed', aliases: ['First'], active: false });
    expect(ok.status).toBe(200);
    expect((await ok.json()).item.label).toBe('Area one renamed');
    expect(scopeCalls()).toEqual([
      {
        fn: 'rag_scope_vocabulary_update',
        args: {
          p_actor: ADMIN_ID,
          p_tenant_key: 's:default',
          p_id: ENTRY_ID,
          p_label: 'Area one renamed',
          p_aliases: ['First'],
          p_active: false,
          p_dimension: null,
          p_value: null,
        },
      },
    ]);
    state.outcomes.rag_scope_vocabulary_update = { data: null, error: { code: 'P0001', message: 'value_immutable' } };
    const changed = await patch(loaded, { id: ENTRY_ID, value: 'a2' });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toEqual({ success: false, error: 'value_immutable' });
    state.outcomes.rag_scope_vocabulary_update = { data: null, error: { code: 'P0001', message: 'not_found' } };
    expect(await (await patch(loaded, { id: ENTRY_ID, active: true })).json()).toEqual({ success: false, error: 'Tag not found' });
  });

  it('refuses more than 20 tags on a document with 400 too_many_scopes and calls nothing', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const scopes = Array.from({ length: 21 }, (_, index) => `department:d${index}`);
    const response = await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes } }), params(DOC_ID));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'too_many_scopes' });
    expect(scopeCalls()).toEqual([]);
  });

  it('passes an empty list through to clear the tags', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_set_document_scopes = { data: [{ document_id: DOC_ID, scopes: [], chunks_updated: 2 }], error: null };
    const response = await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: [] } }), params(DOC_ID));
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, scopes: [] });
    expect(scopeCalls()[0]?.args.p_scopes).toEqual([]);
  });
});

const DOC_ROW = {
  id: DOC_ID,
  filename: FILE_NAME,
  doc_type: 'general',
  status: 'ready',
  version: 1,
  scopes: ['region:a1'],
  suggestions: [
    { dimension: 'department', value: 'd1', source: 'rule' },
    { dimension: 'department', value: 'd2', source: 'model', note: '<img src=x onerror=alert(1)>' },
    { dimension: 'country', value: 'x', source: 'rule' },
  ],
  uploaded_at: '2026-11-24T10:00:00.000Z',
  content: 'document text that must never be answered',
  total_count: 1,
  suggested_count: 1,
};

describe('scope tag routes: document list, switch and workspaces', () => {
  beforeEach(() => {
    resetState();
    state.outcomes.rag_list_documents_with_scopes = { data: [DOC_ROW], error: null };
    for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  });

  it('lists documents with id, file name, type, tags and allow-listed suggestions, 50 per page, never any document text', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.documents.GET(req('/api/rag/admin/documents?scopes=region:a1&scopes=department:d1&q=report'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      total: 1,
      suggested_total: 1,
      limit: 50,
      offset: 0,
      items: [
        {
          id: DOC_ID,
          file_name: FILE_NAME,
          doc_type: 'general',
          status: 'ready',
          version: 1,
          tags: ['region:a1'],
          suggestions: [
            { dimension: 'department', value: 'd1', source: 'rule' },
            { dimension: 'department', value: 'd2', source: 'model' },
          ],
          uploaded_at: '2026-11-24T10:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('document text');
    expect(scopeCalls()).toEqual([
      {
        fn: 'rag_list_documents_with_scopes',
        args: {
          p_actor: ADMIN_ID,
          p_tenant_key: 's:default',
          p_scopes: ['department:d1', 'region:a1'],
          p_query: 'report',
          p_limit: 50,
          p_offset: 0,
          p_filter: 'all',
        },
      },
    ]);
  });

  it('passes the view filter and refuses a malformed tag, view or page with 400', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await loaded.documents.GET(req('/api/rag/admin/documents?filter=untagged&limit=10&offset=20'))).status).toBe(200);
    expect(scopeCalls()[0]?.args).toMatchObject({ p_filter: 'untagged', p_limit: 10, p_offset: 20, p_scopes: null, p_query: null });
    for (const query of ['scopes=region', 'scopes=country:a1', 'filter=everything', 'limit=101', 'offset=-1', `q=${'x'.repeat(201)}`]) {
      expect((await loaded.documents.GET(req(`/api/rag/admin/documents?${query}`))).status, query).toBe(400);
    }
    expect(scopeCalls()).toHaveLength(1);
  });

  it('answers 404 Not found on every route while RAG_SCOPE_TAGS is false, before any lookup, and writes nothing', async () => {
    state.scopeTags = 'false';
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const answers = [
      await loaded.vocabulary.GET(req('/api/rag/admin/scope-vocabulary')),
      await loaded.vocabulary.POST(req('/api/rag/admin/scope-vocabulary', { method: 'POST', body: { dimension: 'region', value: 'a1', label: 'Area one' } })),
      await loaded.vocabulary.PATCH(req('/api/rag/admin/scope-vocabulary', { method: 'PATCH', body: { id: ENTRY_ID, active: false } })),
      await loaded.documents.GET(req('/api/rag/admin/documents')),
      await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: [] } }), params(DOC_ID)),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ success: false, error: 'Not found' });
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it('keeps working for reading and tagging with the legacy ingest pipeline', async () => {
    state.pipeline = 'legacy';
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await loaded.documents.GET(req('/api/rag/admin/documents'))).status).toBe(200);
    expect((await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes`, { method: 'PUT', body: { scopes: ['region:a1'] } }), params(DOC_ID))).status).toBe(200);
  });

  describe('organization admins (multi-tenant)', () => {
    beforeEach(() => {
      state.mode = 'multi-tenant';
      state.tables.organization_members = [
        { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
        { organization_id: ORG_O, user_id: MEMBER_ID, role: 'member' },
      ];
    });

    it("admits O's admin for O only, scoped to O's tenant key", async () => {
      const loaded = await load();
      state.session = { id: ORG_ADMIN_ID };
      expect((await loaded.documents.GET(req(`/api/rag/admin/documents?organizationId=${ORG_O}`))).status).toBe(200);
      expect((await loaded.vocabulary.GET(req(`/api/rag/admin/scope-vocabulary?organizationId=${ORG_O}`))).status).toBe(200);
      expect(scopeCalls().map((call) => call.args.p_tenant_key)).toEqual([`o:${ORG_O}`, `o:${ORG_O}`]);
    });

    it("refuses O's admin for organization P and without an organization, and a member of O, with 403 and no scope call", async () => {
      const loaded = await load();
      state.session = { id: ORG_ADMIN_ID };
      expect((await loaded.documents.GET(req(`/api/rag/admin/documents?organizationId=${ORG_P}`))).status).toBe(403);
      expect((await loaded.documents.GET(req('/api/rag/admin/documents'))).status).toBe(403);
      expect(
        (await loaded.scopes.PUT(req(`/api/rag/admin/documents/${DOC_ID}/scopes?organizationId=${ORG_P}`, { method: 'PUT', body: { scopes: [] } }), params(DOC_ID))).status,
      ).toBe(403);
      expect(
        (
          await loaded.vocabulary.POST(
            req(`/api/rag/admin/scope-vocabulary?organizationId=${ORG_P}`, { method: 'POST', body: { dimension: 'region', value: 'a1', label: 'Area one' } }),
          )
        ).status,
      ).toBe(403);
      state.session = { id: MEMBER_ID };
      expect((await loaded.documents.GET(req(`/api/rag/admin/documents?organizationId=${ORG_O}`))).status).toBe(403);
      expect(scopeCalls()).toEqual([]);
    });

    it("answers P's document ids with the same 404 as an unknown id", async () => {
      const loaded = await load();
      state.session = { id: ORG_ADMIN_ID };
      state.outcomes.rag_set_document_scopes = { data: null, error: { code: 'P0001', message: 'not_found' } };
      const answer = await loaded.scopes.PUT(
        req(`/api/rag/admin/documents/${DOC_ID}/scopes?organizationId=${ORG_O}`, { method: 'PUT', body: { scopes: ['region:a1'] } }),
        params(DOC_ID),
      );
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ success: false, error: 'Document not found' });
      expect(scopeCalls()[0]?.args).toMatchObject({ p_tenant_key: `o:${ORG_O}`, p_actor: ORG_ADMIN_ID });
    });
  });
});
