import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideEffectiveDateProposal, todayUtc } from '@/lib/rag/ingest/versions/effective-dates';

const ADMIN_ID = '00000000-0000-4000-8000-0000000046c1';
const USER_ID = '00000000-0000-4000-8000-0000000046c2';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000046c3';
const P_OWNER_ID = '00000000-0000-4000-8000-0000000046c4';
const ORG_O = '00000000-0000-4000-8000-0000000046d1';
const ORG_P = '00000000-0000-4000-8000-0000000046d2';
const DOC_ID = '00000000-0000-4000-8000-0000000046e1';
const DOC_O = '00000000-0000-4000-8000-0000000046e2';
const DOC_P = '00000000-0000-4000-8000-0000000046e3';
const LINEAGE_ID = '00000000-0000-4000-8000-0000000046e4';
const FILE_NAME = 'neutral-sample-notice.pdf';
const QUOTE = 'This neutral sample applies from the first day of the year.';

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

describe('decideEffectiveDateProposal (D-43 apply rule)', () => {
  const today = '2026-11-25';
  const extracted = { origin: 'extracted' as const };
  const none = { origin: null };

  it.each([
    ['in force today, confidence 0.9', { from: '2026-01-01', to: null, confidence: 0.9 }, none, 'apply'],
    ['exactly 0.8 applies', { from: '2026-01-01', to: '2026-12-31', confidence: 0.8 }, none, 'apply'],
    ['just below 0.8 is ignored', { from: '2026-01-01', to: '2026-12-31', confidence: 0.7999 }, none, 'ignore'],
    ['a window starting today applies', { from: today, to: null, confidence: 0.95 }, none, 'apply'],
    ['a window ending today applies', { from: null, to: today, confidence: 0.95 }, none, 'apply'],
    ['a single-day window on today applies', { from: today, to: today, confidence: 0.95 }, none, 'apply'],
    ['a future start waits, even at confidence 1', { from: '2026-11-26', to: null, confidence: 1 }, none, 'await_confirmation'],
    ['a past end waits', { from: null, to: '2026-11-24', confidence: 0.99 }, none, 'await_confirmation'],
    ['a hiding window waits at low confidence too', { from: '2027-01-01', to: null, confidence: 0.2 }, none, 'await_confirmation'],
    ['over extracted dates, a usable window applies', { from: '2025-01-01', to: null, confidence: 0.9 }, extracted, 'apply'],
    ['an admin origin is never overwritten', { from: '2025-01-01', to: null, confidence: 1 }, { origin: 'admin' as const }, 'keep_admin'],
    ['an admin origin wins over a hiding proposal', { from: '2030-01-01', to: null, confidence: 1 }, { origin: 'admin' as const }, 'keep_admin'],
    ['from later than to is ignored', { from: '2026-12-01', to: '2026-01-01', confidence: 0.9 }, none, 'ignore'],
    ['no date at all is ignored', { from: null, to: null, confidence: 0.9 }, none, 'ignore'],
    ['a malformed date is ignored', { from: '2026-02-30', to: null, confidence: 0.9 }, none, 'ignore'],
    ['a confidence outside 0..1 is ignored', { from: '2026-01-01', to: null, confidence: 1.2 }, none, 'ignore'],
  ])('%s', (_name, proposal, current, expected) => {
    expect(decideEffectiveDateProposal(proposal, current, today)).toBe(expected);
  });

  it('todayUtc takes the UTC calendar date of the injected clock', () => {
    expect(todayUtc(new Date('2026-11-25T23:59:59.999Z'))).toBe('2026-11-25');
    expect(todayUtc(new Date('2026-11-25T00:00:00.000-05:00'))).toBe('2026-11-25');
    expect(todayUtc(new Date('2026-11-25T01:00:00.000+05:00'))).toBe('2026-11-24');
  });
});

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  sessionThrows: false,
  lookupFails: false,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let limit = Infinity;
  const run = () => {
    if (table === 'admin_users' && state.lookupFails) return { data: null, error: { message: 'down' } };
    const rows = (state.tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))).slice(0, limit);
    return { data: rows, error: null };
  };
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
      return Promise.resolve(result.error ? result : { data: result.data?.[0] ?? null, error: null });
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
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.sessionThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => fakeClient() as never });
  const list = await import('@/app/api/rag/admin/effective-dates/route');
  const one = await import('@/app/api/rag/admin/effective-dates/[documentId]/route');
  const dismiss = await import('@/app/api/rag/admin/effective-dates/[documentId]/dismiss/route');
  return { list, one, dismiss };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; authorization?: string; body?: unknown; rawBody?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const params = (documentId: string) => ({ params: Promise.resolve({ documentId }) });
const dateCalls = () => state.rpcCalls.filter((call) => /effective_date/.test(call.fn));

const LIST_ROW = {
  document_id: DOC_ID,
  lineage_id: LINEAGE_ID,
  tenant_key: 's:default',
  filename: FILE_NAME,
  version: 3,
  status: 'ready',
  effective_from: null,
  effective_to: null,
  effective_dates_origin: null,
  effective_dates_confidence: null,
  proposal: { from: '2027-01-01', to: null, confidence: 0.86, evidence_quote: QUOTE, status: 'awaiting_confirmation', proposed_at: '2026-11-24T10:00:00+00:00' },
  total_count: 1,
};

function setRow(overrides: Row = {}): RpcOutcome {
  return {
    data: [
      {
        outcome: 'set',
        document_id: DOC_ID,
        effective_from: '2025-01-01',
        effective_to: '2025-12-31',
        effective_dates_origin: 'admin',
        effective_dates_confidence: null,
        chunks_updated: 4,
        ...overrides,
      },
    ],
    error: null,
  };
}

function resetState() {
  state.mode = 'single-tenant';
  state.session = null;
  state.tokens = {};
  state.sessionThrows = false;
  state.lookupFails = false;
  state.rpcCalls = [];
  state.tables = {
    admin_users: [{ id: ADMIN_ID }],
    organization_members: [],
    documents: [
      { id: DOC_ID, tenant_key: 's:default' },
      { id: DOC_P, tenant_key: `o:${ORG_P}` },
    ],
  };
  state.outcomes = {
    rag_list_effective_date_proposals: { data: [LIST_ROW], error: null },
    rag_set_document_effective_dates: setRow(),
    rag_dismiss_effective_date_proposal: { data: [{ outcome: 'dismissed', document_id: DOC_ID }], error: null },
  };
}

describe('effective-date routes: deployment admin (single-tenant)', () => {
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

  const ROUTES = [
    { name: 'GET list', call: (l: Loaded, init?: Parameters<typeof req>[1]) => l.list.GET(req('/api/rag/admin/effective-dates', init)) },
    {
      name: 'PUT dates',
      call: (l: Loaded, init?: Parameters<typeof req>[1]) =>
        l.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_ID}`, { method: 'PUT', body: { from: '2025-01-01', to: null }, ...init }), params(DOC_ID)),
    },
    {
      name: 'POST dismiss',
      call: (l: Loaded, init?: Parameters<typeof req>[1]) => l.dismiss.POST(req(`/api/rag/admin/effective-dates/${DOC_ID}/dismiss`, { method: 'POST', ...init }), params(DOC_ID)),
    },
  ];

  describe.each(ROUTES)('$name fails closed', (route) => {
    it('gives 401 without a credential, 503 when auth or the admin lookup fails, 403 to a non-admin, and calls no date function', async () => {
      const loaded = await load();
      const unauthenticated = await route.call(loaded);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get('cache-control')).toBe('no-store');
      state.sessionThrows = true;
      expect((await route.call(loaded)).status).toBe(503);
      state.sessionThrows = false;
      state.session = { id: ADMIN_ID };
      state.lookupFails = true;
      expect((await route.call(loaded)).status).toBe(503);
      state.lookupFails = false;
      state.session = { id: USER_ID };
      expect((await route.call(loaded)).status).toBe(403);
      expect(dateCalls()).toEqual([]);
    });

    it('admits an admin by session and by bearer token', async () => {
      const loaded = await load();
      state.session = { id: ADMIN_ID };
      expect((await route.call(loaded)).status).toBe(200);
      state.session = null;
      state.tokens = { 'token-admin': ADMIN_ID };
      expect((await route.call(loaded, { authorization: 'Bearer token-admin' })).status).toBe(200);
    });
  });

  it('GET lists proposals with the awaiting flag and the evidence quote as a plain string', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.GET(req('/api/rag/admin/effective-dates?limit=20&offset=0'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      total: 1,
      limit: 20,
      offset: 0,
      query: null,
      items: [
        {
          id: DOC_ID,
          lineage_id: LINEAGE_ID,
          file_name: FILE_NAME,
          version: 3,
          status: 'ready',
          effective_from: null,
          effective_to: null,
          origin: null,
          confidence: null,
          proposal: { from: '2027-01-01', to: null, confidence: 0.86, evidence_quote: QUOTE, awaiting: true, proposed_at: '2026-11-24T10:00:00.000Z' },
        },
      ],
    });
    expect(state.rpcCalls).toEqual([
      { fn: 'rag_list_effective_date_proposals', args: { p_actor: ADMIN_ID, p_tenant_key: 's:default', p_query: null, p_limit: 20, p_offset: 0 } },
    ]);
    const logs = logged.join('\n');
    expect(logs).not.toContain(FILE_NAME);
    expect(logs).not.toContain(QUOTE);
  });

  it('GET passes a trimmed file-name search and refuses out-of-range paging or an over-long query', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    expect((await loaded.list.GET(req('/api/rag/admin/effective-dates?query=%20notice%20'))).status).toBe(200);
    expect(state.rpcCalls[0]?.args.p_query).toBe('notice');
    state.rpcCalls = [];
    for (const q of ['limit=0', 'limit=101', 'offset=-1', `query=${'x'.repeat(201)}`]) {
      expect((await loaded.list.GET(req(`/api/rag/admin/effective-dates?${q}`))).status, q).toBe(400);
    }
    expect(dateCalls()).toEqual([]);
  });

  it('GET drops a malformed evidence quote instead of passing a non-string through', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_list_effective_date_proposals = { data: [{ ...LIST_ROW, proposal: { ...LIST_ROW.proposal, evidence_quote: { html: '<b>x</b>' } } }], error: null };
    const body = await (await loaded.list.GET(req('/api/rag/admin/effective-dates'))).json();
    expect(body.items[0].proposal.evidence_quote).toBeNull();
  });

  it('PUT sets the window with the verified admin as the actor and origin admin, never a body actor', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_ID}`, { method: 'PUT', body: { from: '2025-01-01', to: '2025-12-31' } }), params(DOC_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, effective_from: '2025-01-01', effective_to: '2025-12-31', origin: 'admin' });
    expect(dateCalls()).toEqual([
      {
        fn: 'rag_set_document_effective_dates',
        args: {
          p_document_id: DOC_ID,
          p_tenant_key: 's:default',
          p_from: '2025-01-01',
          p_to: '2025-12-31',
          p_origin: 'admin',
          p_confidence: null,
          p_actor: ADMIN_ID,
        },
      },
    ]);
  });

  it('PUT with both dates null clears the window', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_set_document_effective_dates = setRow({ effective_from: null, effective_to: null });
    const response = await loaded.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_ID}`, { method: 'PUT', body: { from: null, to: null } }), params(DOC_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ effective_from: null, effective_to: null, origin: 'admin' });
    expect(dateCalls()[0]?.args).toMatchObject({ p_from: null, p_to: null, p_origin: 'admin' });
  });

  it('PUT refuses an inverted window, malformed dates, unknown keys and a bad id with 400 before any call', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const bodies: unknown[] = [
      { from: '2025-02-01', to: '2025-01-31' },
      { from: '2025-02-30', to: null },
      { from: '01/02/2025', to: null },
      { from: '2025-01-01T00:00:00Z', to: null },
      { from: 20250101, to: null },
      { from: '2025-01-01' },
      { from: '2025-01-01', to: null, actor: USER_ID },
      { from: '2025-01-01', to: null, origin: 'extracted' },
    ];
    for (const body of bodies) {
      const response = await loaded.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_ID}`, { method: 'PUT', body }), params(DOC_ID));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await loaded.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_ID}`, { method: 'PUT', rawBody: '{bad' }), params(DOC_ID))).status).toBe(400);
    const badId = await loaded.one.PUT(req('/api/rag/admin/effective-dates/not-a-uuid', { method: 'PUT', body: { from: null, to: null } }), params('not-a-uuid'));
    expect(badId.status).toBe(400);
    expect(dateCalls()).toEqual([]);
  });

  it('PUT maps the database words: invalid_window 400, not_found 404, anything else 503 without the message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const put = () => loaded.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_ID}`, { method: 'PUT', body: { from: '2025-01-01', to: null } }), params(DOC_ID));
    state.outcomes.rag_set_document_effective_dates = { data: null, error: { message: 'invalid_window' } };
    expect((await put()).status).toBe(400);
    state.outcomes.rag_set_document_effective_dates = { data: null, error: { message: 'not_found' } };
    expect((await put()).status).toBe(404);
    state.outcomes.rag_set_document_effective_dates = { data: null, error: { message: 'relation "documents" secret detail' } };
    const failed = await put();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
  });

  it("an unknown id and another workspace's id give the same 404 and no date function runs", async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const unknown = '00000000-0000-4000-8000-0000000046ff';
    for (const id of [unknown, DOC_P]) {
      const put = await loaded.one.PUT(req(`/api/rag/admin/effective-dates/${id}`, { method: 'PUT', body: { from: null, to: null } }), params(id));
      expect(put.status).toBe(404);
      expect(await put.json()).toEqual({ success: false, error: 'Document not found' });
      const dismissed = await loaded.dismiss.POST(req(`/api/rag/admin/effective-dates/${id}/dismiss`, { method: 'POST' }), params(id));
      expect(dismissed.status).toBe(404);
    }
    expect(dateCalls()).toEqual([]);
  });

  it('POST dismiss drops the proposal with the verified actor; no proposal is 409; a body is refused', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.dismiss.POST(req(`/api/rag/admin/effective-dates/${DOC_ID}/dismiss`, { method: 'POST', body: {} }), params(DOC_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, outcome: 'dismissed' });
    expect(dateCalls()).toEqual([
      { fn: 'rag_dismiss_effective_date_proposal', args: { p_document_id: DOC_ID, p_tenant_key: 's:default', p_actor: ADMIN_ID } },
    ]);
    state.outcomes.rag_dismiss_effective_date_proposal = { data: null, error: { message: 'no_proposal' } };
    expect((await loaded.dismiss.POST(req(`/api/rag/admin/effective-dates/${DOC_ID}/dismiss`, { method: 'POST' }), params(DOC_ID))).status).toBe(409);
    state.rpcCalls = [];
    const withBody = await loaded.dismiss.POST(req(`/api/rag/admin/effective-dates/${DOC_ID}/dismiss`, { method: 'POST', body: { actor: USER_ID } }), params(DOC_ID));
    expect(withBody.status).toBe(400);
    expect(dateCalls()).toEqual([]);
  });
});

describe('effective-date routes: organization admin (multi-tenant)', () => {
  beforeEach(() => {
    resetState();
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: USER_ID, role: 'member' },
      { organization_id: ORG_P, user_id: P_OWNER_ID, role: 'owner' },
    ];
    state.tables.documents.push({ id: DOC_O, tenant_key: `o:${ORG_O}` });
    state.outcomes.rag_list_effective_date_proposals = { data: [{ ...LIST_ROW, document_id: DOC_O, tenant_key: `o:${ORG_O}` }], error: null };
    state.outcomes.rag_set_document_effective_dates = setRow({ document_id: DOC_O });
    for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  });

  it("admits an organization admin for that organization's tenant only", async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const listed = await loaded.list.GET(req(`/api/rag/admin/effective-dates?organizationId=${ORG_O}`));
    expect(listed.status).toBe(200);
    expect(state.rpcCalls).toContainEqual({
      fn: 'rag_list_effective_date_proposals',
      args: { p_actor: ORG_ADMIN_ID, p_tenant_key: `o:${ORG_O}`, p_query: null, p_limit: 50, p_offset: 0 },
    });
    const put = await loaded.one.PUT(
      req(`/api/rag/admin/effective-dates/${DOC_O}?organizationId=${ORG_O}`, { method: 'PUT', body: { from: '2025-01-01', to: '2025-12-31' } }),
      params(DOC_O),
    );
    expect(put.status).toBe(200);
    expect(dateCalls().at(-1)).toMatchObject({ fn: 'rag_set_document_effective_dates', args: { p_tenant_key: `o:${ORG_O}`, p_actor: ORG_ADMIN_ID } });

    state.rpcCalls = [];
    expect((await loaded.list.GET(req(`/api/rag/admin/effective-dates?organizationId=${ORG_P}`))).status).toBe(403);
    expect((await loaded.list.GET(req('/api/rag/admin/effective-dates'))).status).toBe(403);
    const foreign = await loaded.one.PUT(
      req(`/api/rag/admin/effective-dates/${DOC_P}?organizationId=${ORG_O}`, { method: 'PUT', body: { from: null, to: null } }),
      params(DOC_P),
    );
    expect(foreign.status).toBe(404);
    expect(dateCalls()).toEqual([]);
  });

  it('denies a plain member of the organization', async () => {
    const loaded = await load();
    state.session = { id: USER_ID };
    expect((await loaded.list.GET(req(`/api/rag/admin/effective-dates?organizationId=${ORG_O}`))).status).toBe(403);
    expect(
      (await loaded.one.PUT(req(`/api/rag/admin/effective-dates/${DOC_O}?organizationId=${ORG_O}`, { method: 'PUT', body: { from: null, to: null } }), params(DOC_O))).status,
    ).toBe(403);
    expect(dateCalls()).toEqual([]);
  });
});

describe('recordExtractedEffectiveDates (pipeline path)', () => {
  const NOW = new Date('2026-11-25T12:00:00.000Z');

  beforeEach(() => {
    resetState();
    for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  });

  async function record(proposal: { from: string | null; to: string | null; confidence: number; evidenceQuote?: string | null }, origin: 'admin' | 'extracted' | null = null) {
    await load();
    const service = await import('@/lib/rag/ingest/versions/effective-dates');
    return service.recordExtractedEffectiveDates({ documentId: DOC_ID, tenantKey: 's:default', proposal, current: { origin }, now: NOW });
  }

  it('applies a usable window at confidence 0.8 or more through the service path with origin extracted', async () => {
    state.outcomes.rag_set_document_effective_dates = setRow({ effective_dates_origin: 'extracted' });
    expect(await record({ from: '2026-01-01', to: null, confidence: 0.8 })).toEqual({ ok: true, decision: 'apply', outcome: 'applied' });
    expect(dateCalls()).toEqual([
      {
        fn: 'rag_set_document_effective_dates',
        args: { p_document_id: DOC_ID, p_tenant_key: 's:default', p_from: '2026-01-01', p_to: null, p_origin: 'extracted', p_confidence: 0.8, p_actor: null },
      },
    ]);
  });

  it('stores a window that would hide the document as awaiting confirmation and never applies it', async () => {
    state.outcomes.rag_propose_document_effective_dates = { data: [{ outcome: 'stored', document_id: DOC_ID }], error: null };
    expect(await record({ from: '2026-12-01', to: null, confidence: 0.99, evidenceQuote: QUOTE })).toEqual({ ok: true, decision: 'await_confirmation', outcome: 'stored' });
    expect(dateCalls().map((call) => call.fn)).toEqual(['rag_propose_document_effective_dates']);
    expect(dateCalls()[0]?.args).toMatchObject({ p_status: 'awaiting_confirmation', p_evidence_quote: QUOTE, p_from: '2026-12-01' });
  });

  it('stores a low-confidence usable window as low_confidence', async () => {
    state.outcomes.rag_propose_document_effective_dates = { data: [{ outcome: 'stored', document_id: DOC_ID }], error: null };
    expect(await record({ from: '2026-01-01', to: null, confidence: 0.79 })).toEqual({ ok: true, decision: 'ignore', outcome: 'stored' });
    expect(dateCalls()[0]?.args).toMatchObject({ p_status: 'low_confidence' });
  });

  it('changes nothing over admin-set dates, and accepts the SQL kept_admin answer when an admin won a race', async () => {
    expect(await record({ from: '2026-01-01', to: null, confidence: 1 }, 'admin')).toEqual({ ok: true, decision: 'keep_admin', outcome: 'kept_admin' });
    expect(dateCalls()).toEqual([]);
    state.outcomes.rag_set_document_effective_dates = setRow({ outcome: 'kept_admin' });
    expect(await record({ from: '2026-01-01', to: null, confidence: 1 })).toEqual({ ok: true, decision: 'keep_admin', outcome: 'kept_admin' });
  });

  it('skips a proposal with no date or an inverted window without any call', async () => {
    expect(await record({ from: null, to: null, confidence: 0.9 })).toEqual({ ok: true, decision: 'ignore', outcome: 'skipped' });
    expect(await record({ from: '2026-12-01', to: '2026-01-01', confidence: 0.9 })).toEqual({ ok: true, decision: 'ignore', outcome: 'skipped' });
    expect(dateCalls()).toEqual([]);
  });
});
