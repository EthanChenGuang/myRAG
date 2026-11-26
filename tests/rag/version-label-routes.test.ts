import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Plan 05.2-21 (GEN-14, D-49): the Phase 3.2 dates editor saves an optional version label with the dates through
// rag_set_document_version_label for the document's own tenant, and both the dates list and the supersession list return version_label.
// The database is a fake: rpc answers by function name, and the documents table holds tenant_key and version_label.

const ADMIN_ID = '00000000-0000-4000-8000-0000000521a1';
const USER_ID = '00000000-0000-4000-8000-0000000521a2';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000521a3';
const ORG_O = '00000000-0000-4000-8000-0000000521b1';
const ORG_P = '00000000-0000-4000-8000-0000000521b2';
const DOC_ID = '00000000-0000-4000-8000-0000000521c1';
const DOC_OTHER = '00000000-0000-4000-8000-0000000521c2';
const DOC_O = '00000000-0000-4000-8000-0000000521c3';
const DOC_P = '00000000-0000-4000-8000-0000000521c4';
const CAND_ID = '00000000-0000-4000-8000-0000000521d1';

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
  documentsFail: false,
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const run = () => {
    if (table === 'documents' && state.documentsFail) return { data: null, error: { message: 'down' } };
    return { data: (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))), error: null };
  };
  const builder = {
    select: () => builder,
    abortSignal: () => builder,
    order: () => builder,
    limit: () => builder,
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
      return Promise.resolve(result.error ? result : { data: result.data?.[0] ?? null, error: null });
    },
    then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve(run()).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

/** rag_set_document_version_label as 0941 defines it: trimmed, empty is null, only a document of p_tenant_key. */
function setVersionLabel(args: Record<string, unknown>): RpcOutcome {
  const label = typeof args.p_label === 'string' ? args.p_label.trim() : null;
  if (label !== null && label.length > 40) return { data: null, error: { code: '22023', message: 'version label must be at most 40 characters' } };
  const row = (state.tables.documents ?? []).find((doc) => doc.id === args.p_document_id && doc.tenant_key === args.p_tenant_key);
  if (!row) return { data: false, error: null };
  row.version_label = label === '' ? null : label;
  return { data: true, error: null };
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
      const outcome = fn === 'rag_set_document_version_label' ? setVersionLabel(args) : (state.outcomes[fn] ?? { data: [], error: null });
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
  deps.setIngestDepsForTests({ db: () => fakeClient() as never });
  return {
    list: await import('@/app/api/rag/admin/effective-dates/route'),
    one: await import('@/app/api/rag/admin/effective-dates/[documentId]/route'),
    supersession: await import('@/app/api/rag/admin/supersession/route'),
  };
}

function req(url: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = (documentId: string) => ({ params: Promise.resolve({ documentId }) });
const labelCalls = () => state.rpcCalls.filter((call) => call.fn === 'rag_set_document_version_label');
const labelOf = (id: string) => (state.tables.documents ?? []).find((doc) => doc.id === id)?.version_label;

function listRow(documentId: string, tenantKey: string): Row {
  return {
    document_id: documentId,
    lineage_id: documentId,
    tenant_key: tenantKey,
    filename: 'neutral-sample.md',
    version: 2,
    status: 'ready',
    effective_from: null,
    effective_to: null,
    effective_dates_origin: null,
    effective_dates_confidence: null,
    proposal: null,
    total_count: 1,
  };
}

function setRow(documentId: string): RpcOutcome {
  return {
    data: [{ outcome: 'set', document_id: documentId, effective_from: '2025-01-01', effective_to: null, effective_dates_origin: 'admin', chunks_updated: 2 }],
    error: null,
  };
}

const docJson = (id: string) => ({ id, lineage_id: id, filename: `neutral-${id.slice(-2)}.md`, doc_type: 'general', doc_date: null, effective_from: null, effective_to: null, uploaded_at: null, uploader_id: null, version: 1, is_current: true, status: 'ready' });

beforeEach(() => {
  state.mode = 'single-tenant';
  state.session = { id: ADMIN_ID };
  state.rpcCalls = [];
  state.documentsFail = false;
  state.tables = {
    admin_users: [{ id: ADMIN_ID }],
    organization_members: [],
    documents: [
      { id: DOC_ID, tenant_key: 's:default', version_label: null },
      { id: DOC_OTHER, tenant_key: 's:default', version_label: 'Rev 7' },
      { id: DOC_P, tenant_key: `o:${ORG_P}`, version_label: 'P-1' },
    ],
  };
  state.outcomes = {
    rag_list_effective_date_proposals: { data: [listRow(DOC_ID, 's:default')], error: null },
    rag_set_document_effective_dates: setRow(DOC_ID),
    rag_list_supersession: {
      data: [
        {
          kind: 'candidate', candidate_id: CAND_ID, link_id: null, tenant_key: 's:default', status: 'pending', stale: false, origin: 'detected',
          direction: 'document_newer', signals: {}, older_document_id: DOC_OTHER, document: docJson(DOC_ID), candidate_document: docJson(DOC_OTHER),
          created_at: '2026-01-03T00:00:00.000Z', decided_by: null, decided_at: null, total_count: 1,
        },
      ],
      error: null,
    },
  };
  for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
});

const put = (loaded: Awaited<ReturnType<typeof load>>, body: unknown, id = DOC_ID, query = '') =>
  loaded.one.PUT(req(`/api/rag/admin/effective-dates/${id}${query}`, { method: 'PUT', body }), params(id));

describe('version label saved with the dates (D-49)', () => {
  it('stores the label with the dates for the admitted tenant, and the next list returns it', async () => {
    const loaded = await load();
    const response = await put(loaded, { from: '2025-01-01', to: null, versionLabel: '  B-2 ' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, effective_from: '2025-01-01', effective_to: null, origin: 'admin', version_label: 'B-2' });
    expect(state.rpcCalls.map((call) => call.fn)).toEqual(['rag_set_document_effective_dates', 'rag_set_document_version_label']);
    expect(labelCalls()[0]?.args).toEqual({ p_tenant_key: 's:default', p_document_id: DOC_ID, p_label: 'B-2' });
    expect(labelOf(DOC_ID)).toBe('B-2');

    const listed = await (await loaded.list.GET(req('/api/rag/admin/effective-dates'))).json();
    expect(listed.items[0]).toMatchObject({ id: DOC_ID, version_label: 'B-2' });
  });

  it('an empty label clears it, null clears it, and an absent label leaves it unchanged with no label call', async () => {
    const loaded = await load();
    state.outcomes.rag_set_document_effective_dates = setRow(DOC_OTHER);
    const cleared = await put(loaded, { from: null, to: null, versionLabel: '   ' }, DOC_OTHER);
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).version_label).toBeNull();
    expect(labelOf(DOC_OTHER)).toBeNull();

    state.tables.documents![1]!.version_label = 'Rev 7';
    expect((await put(loaded, { from: null, to: null, versionLabel: null }, DOC_OTHER)).status).toBe(200);
    expect(labelOf(DOC_OTHER)).toBeNull();

    state.tables.documents![1]!.version_label = 'Rev 7';
    state.rpcCalls = [];
    const unchanged = await put(loaded, { from: null, to: null }, DOC_OTHER);
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).not.toHaveProperty('version_label');
    expect(labelCalls()).toEqual([]);
    expect(labelOf(DOC_OTHER)).toBe('Rev 7');
  });

  it('refuses a label over 40 characters, a control character or a non-string with 400 and details, before any call', async () => {
    const loaded = await load();
    for (const versionLabel of ['x'.repeat(41), 'line\nbreak', 'tab\there', 42, { text: 'x' }]) {
      const response = await put(loaded, { from: null, to: null, versionLabel });
      expect(response.status, JSON.stringify(versionLabel)).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.details?.[0]?.path).toBe('versionLabel');
    }
    expect((await put(loaded, { from: null, to: null, versionLabel: `  ${'x'.repeat(40)}  ` })).status).toBe(200);
    expect(state.rpcCalls.filter((call) => call.fn !== 'rag_set_document_version_label' && call.fn !== 'rag_set_document_effective_dates')).toEqual([]);
    expect(state.rpcCalls.map((call) => call.fn)).toEqual(['rag_set_document_effective_dates', 'rag_set_document_version_label']);
  });

  it('answers 503 without the database message when the label setter fails', async () => {
    const loaded = await load();
    const real = fakeClient();
    const deps = await import('@/lib/rag/ingest/deps');
    deps.setIngestDepsForTests({
      db: () =>
        ({
          rpc(fn: string, args: Record<string, unknown>) {
            if (fn !== 'rag_set_document_version_label') return real.rpc(fn, args);
            const request = { abortSignal: () => request, then: (ok: (v: RpcOutcome) => unknown) => Promise.resolve({ data: null, error: { code: 'XX000', message: 'secret detail' } }).then(ok) };
            return request;
          },
        }) as never,
    });
    const response = await put(loaded, { from: null, to: null, versionLabel: 'B-2' });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });
});

describe('version label: tenant isolation (multi-tenant)', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = { id: ORG_ADMIN_ID };
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: USER_ID, role: 'member' },
    ];
    state.tables.documents!.push({ id: DOC_O, tenant_key: `o:${ORG_O}`, version_label: null });
    state.outcomes.rag_set_document_effective_dates = setRow(DOC_O);
    state.outcomes.rag_list_effective_date_proposals = { data: [listRow(DOC_O, `o:${ORG_O}`)], error: null };
  });

  it("an organization admin labels their tenant's document and gets 404 for another tenant's, with nothing written", async () => {
    const loaded = await load();
    const own = await put(loaded, { from: null, to: null, versionLabel: 'B-2' }, DOC_O, `?organizationId=${ORG_O}`);
    expect(own.status).toBe(200);
    expect(labelCalls()[0]?.args).toEqual({ p_tenant_key: `o:${ORG_O}`, p_document_id: DOC_O, p_label: 'B-2' });

    state.rpcCalls = [];
    const foreign = await put(loaded, { from: null, to: null, versionLabel: 'B-3' }, DOC_P, `?organizationId=${ORG_O}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ success: false, error: 'Document not found' });
    expect(state.rpcCalls).toEqual([]);
    expect(labelOf(DOC_P)).toBe('P-1');
  });

  it("the dates list reads labels of the admitted tenant only", async () => {
    const loaded = await load();
    state.tables.documents!.find((doc) => doc.id === DOC_O)!.version_label = 'O-4';
    state.outcomes.rag_list_effective_date_proposals = { data: [listRow(DOC_O, `o:${ORG_O}`), { ...listRow(DOC_P, `o:${ORG_O}`), total_count: 2 }], error: null };
    const body = await (await loaded.list.GET(req(`/api/rag/admin/effective-dates?organizationId=${ORG_O}`))).json();
    expect(body.items.map((item: Row) => [item.id, item.version_label])).toEqual([
      [DOC_O, 'O-4'],
      [DOC_P, null],
    ]);
  });
});

describe('version_label in the lists (UI-SPEC 8.1)', () => {
  it('the dates list returns version_label for each document, null when unset', async () => {
    const loaded = await load();
    state.outcomes.rag_list_effective_date_proposals = { data: [listRow(DOC_ID, 's:default'), { ...listRow(DOC_OTHER, 's:default'), total_count: 2 }], error: null };
    const body = await (await loaded.list.GET(req('/api/rag/admin/effective-dates'))).json();
    expect(body.items.map((item: Row) => [item.id, item.version_label])).toEqual([
      [DOC_ID, null],
      [DOC_OTHER, 'Rev 7'],
    ]);
  });

  it('the dates list answers 503 when the labels cannot be read, so an editor never shows a missing label as empty', async () => {
    const loaded = await load();
    state.documentsFail = true;
    expect((await loaded.list.GET(req('/api/rag/admin/effective-dates'))).status).toBe(503);
  });

  it('the supersession list returns version_label on both documents of a candidate', async () => {
    const loaded = await load();
    const response = await loaded.supersession.GET(req('/api/rag/admin/supersession'));
    expect(response.status).toBe(200);
    const item = (await response.json()).items[0];
    expect(item.document).toMatchObject({ id: DOC_ID, version_label: null });
    expect(item.candidate_document).toMatchObject({ id: DOC_OTHER, version_label: 'Rev 7' });
  });
});
