import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000016a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000016a2';
const UPLOADER_ID = '00000000-0000-4000-8000-0000000016b1';
const MEMBER_ID = '00000000-0000-4000-8000-0000000016b2';
const ORG_O = '00000000-0000-4000-8000-0000000016c1';
const ORG_P = '00000000-0000-4000-8000-0000000016c2';
const DOC_ID = '00000000-0000-4000-8000-0000000016d1';
const LINEAGE_ID = '00000000-0000-4000-8000-0000000016d2';
const DOC_P = '00000000-0000-4000-8000-0000000016d3';
const EXEMPTION_ID = '00000000-0000-4000-8000-0000000016e1';
const FILE_NAME = 'neutral-sample-report.pdf';
const UPLOADER_EMAIL = 'uploader@example.invalid';
const REPO_ROOT = path.resolve(__dirname, '../..');

type Row = Record<string, unknown>;
type RpcOutcome = { data: Row[] | null; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  approval: 'members',
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  sessionThrows: false,
  lookupFails: false,
  membershipFails: false,
  tables: {} as Record<string, Row[]>,
  users: {} as Record<string, { id: string; email?: string; user_metadata?: Row }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome>,
  tableReads: [] as string[],
};

function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let limit = Infinity;
  const run = () => {
    state.tableReads.push(table);
    if (table === 'admin_users' && state.lookupFails) return { data: null, error: { message: 'down' } };
    if (table === 'organization_members' && state.membershipFails) return { data: null, error: { message: 'down' } };
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
      admin: {
        getUserById: async (id: string) => {
          const user = state.users[id];
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'not found' } };
        },
        listUsers: async () => ({ data: { users: Object.values(state.users) }, error: null }),
      },
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
  deps.setIngestDepsForTests({ db: () => fakeClient() as never, ingestEnv: () => ({ RAG_UPLOAD_APPROVAL: state.approval }) });
  const hooks = await import('@/lib/rag/ingest/post-publish');
  const hookCalls: Array<{ documentId: string; tenantKey: string }> = [];
  hooks.resetPostPublishHooksForTests();
  hooks.registerPostPublishHook('test', (event) => {
    hookCalls.push(event);
  });
  const list = await import('@/app/api/rag/admin/upload-approvals/route');
  const approve = await import('@/app/api/rag/admin/upload-approvals/[id]/approve/route');
  const reject = await import('@/app/api/rag/admin/upload-approvals/[id]/reject/route');
  const exemptions = await import('@/app/api/rag/admin/upload-approvals/exemptions/route');
  return { list, approve, reject, exemptions, hookCalls };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; authorization?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PENDING_ROW = {
  document_id: DOC_ID,
  lineage_id: LINEAGE_ID,
  tenant_key: 's:default',
  filename: FILE_NAME,
  source: 'upload',
  doc_type: 'general',
  version: 2,
  uploader_id: UPLOADER_ID,
  uploaded_at: '2026-11-24T10:00:00.000Z',
  new_version: true,
  total_count: 1,
};
const EXEMPTION_ROW = {
  id: EXEMPTION_ID,
  tenant_key: 's:default',
  kind: 'uploader',
  ref: MEMBER_ID,
  created_by: ADMIN_ID,
  created_at: '2026-11-23T09:00:00.000Z',
  total_count: 1,
};

const approvalCalls = () => state.rpcCalls.filter((call) => /^rag_(approve|reject|list_pending|upload_exemption)/.test(call.fn));

function resetState() {
  state.mode = 'single-tenant';
  state.approval = 'members';
  state.session = null;
  state.tokens = {};
  state.sessionThrows = false;
  state.lookupFails = false;
  state.membershipFails = false;
  state.rpcCalls = [];
  state.tableReads = [];
  state.tables = {
    admin_users: [{ id: ADMIN_ID }, { id: OTHER_ADMIN_ID }],
    organization_members: [],
    documents: [
      { id: DOC_ID, tenant_key: 's:default' },
      { id: DOC_P, tenant_key: `o:${ORG_P}` },
    ],
    rag_upload_approval_exemptions: [{ id: EXEMPTION_ID, tenant_key: 's:default' }],
    nango_connections: [],
  };
  state.users = {
    [ADMIN_ID]: { id: ADMIN_ID, email: 'admin@example.invalid' },
    [UPLOADER_ID]: { id: UPLOADER_ID, email: UPLOADER_EMAIL },
    [MEMBER_ID]: { id: MEMBER_ID, email: 'member@example.invalid' },
  };
  state.outcomes = {
    rag_list_pending_uploads: { data: [PENDING_ROW], error: null },
    rag_upload_exemption_list: { data: [EXEMPTION_ROW], error: null },
    rag_approve_upload: { data: [{ outcome: 'published', document_id: DOC_ID, version: 2, superseded_document_id: null }], error: null },
    rag_reject_upload: { data: [{ outcome: 'deleted', document_id: DOC_ID, lineage_id: LINEAGE_ID, version: 2 }], error: null },
  };
}

describe('upload approval routes: deployment admin', () => {
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
    { name: 'GET list', call: (l: Loaded, init?: Parameters<typeof req>[1]) => l.list.GET(req('/api/rag/admin/upload-approvals', init)) },
    {
      name: 'POST approve',
      call: (l: Loaded, init?: Parameters<typeof req>[1]) => l.approve.POST(req(`/api/rag/admin/upload-approvals/${DOC_ID}/approve`, { method: 'POST', ...init }), params(DOC_ID)),
    },
    {
      name: 'POST reject',
      call: (l: Loaded, init?: Parameters<typeof req>[1]) => l.reject.POST(req(`/api/rag/admin/upload-approvals/${DOC_ID}/reject`, { method: 'POST', ...init }), params(DOC_ID)),
    },
  ];

  describe.each(ROUTES)('$name fails closed', (route) => {
    it('gives 401 without a credential, 503 when auth or the admin lookup fails, 403 to a non-admin, and runs no approval function', async () => {
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
      state.session = { id: UPLOADER_ID };
      const denied = await route.call(loaded);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ success: false, error: 'Admin access required' });
      state.session = null;
      state.tokens = { 'token-user': MEMBER_ID };
      expect((await route.call(loaded, { authorization: 'Bearer token-user' })).status).toBe(403);
      expect(approvalCalls()).toEqual([]);
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

  it('lists the mode, pending rows with the uploader display, the total and the exemptions, scoped to the workspace', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.list.GET(req('/api/rag/admin/upload-approvals?limit=20&offset=0', { headers: { 'x-actor-id': OTHER_ADMIN_ID } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      success: true,
      mode: 'members',
      total: 1,
      limit: 20,
      offset: 0,
      items: [
        {
          id: DOC_ID,
          lineage_id: LINEAGE_ID,
          file_name: FILE_NAME,
          uploader: { id: UPLOADER_ID, display: UPLOADER_EMAIL },
          source: 'upload',
          doc_type: 'general',
          version: 2,
          uploaded_at: '2026-11-24T10:00:00.000Z',
          new_version: true,
        },
      ],
      exemptions: [
        {
          id: EXEMPTION_ID,
          kind: 'uploader',
          ref: MEMBER_ID,
          display: 'member@example.invalid',
          added_by: { id: ADMIN_ID, display: 'admin@example.invalid' },
          added_at: '2026-11-23T09:00:00.000Z',
        },
      ],
      exemptions_total: 1,
    });
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_list_pending_uploads', args: { p_actor: ADMIN_ID, p_tenant_key: 's:default', p_limit: 20, p_offset: 0 } });
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_upload_exemption_list', args: { p_actor: ADMIN_ID, p_tenant_key: 's:default', p_limit: 100, p_offset: 0 } });
    const logs = logged.join('\n');
    expect(logs).not.toContain(FILE_NAME);
    expect(logs).not.toContain(UPLOADER_EMAIL);
  });

  it('shows the uploader id when the user lookup has no answer', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    delete state.users[UPLOADER_ID];
    const body = await (await loaded.list.GET(req('/api/rag/admin/upload-approvals'))).json();
    expect(body.items[0].uploader).toEqual({ id: UPLOADER_ID, display: UPLOADER_ID });
  });

  it('rejects a list query outside the limits with 400', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc']) {
      expect((await loaded.list.GET(req(`/api/rag/admin/upload-approvals?${query}`))).status, query).toBe(400);
    }
    expect(approvalCalls()).toEqual([]);
  });

  it('approves: calls rag_approve_upload with the verified admin id, then afterPublish, and answers the outcome', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.approve.POST(
      req(`/api/rag/admin/upload-approvals/${DOC_ID}/approve`, { method: 'POST', body: {}, headers: { 'x-actor-id': OTHER_ADMIN_ID } }),
      params(DOC_ID),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, outcome: 'published', status: 'ready', version: 2, superseded_document_id: null });
    expect(approvalCalls()).toEqual([{ fn: 'rag_approve_upload', args: { p_document_id: DOC_ID, p_actor: ADMIN_ID } }]);
    await flush();
    expect(loaded.hookCalls).toEqual([{ documentId: DOC_ID, tenantKey: 's:default' }]);
    expect(logged.some((line) => line.includes('[RAG Admin]') && line.includes(DOC_ID))).toBe(true);
  });

  it('rejects: calls rag_reject_upload with the verified admin id and runs no post-publish work', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await loaded.reject.POST(req(`/api/rag/admin/upload-approvals/${DOC_ID}/reject`, { method: 'POST' }), params(DOC_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, outcome: 'deleted', status: 'deleted', version: 2 });
    expect(approvalCalls()).toEqual([{ fn: 'rag_reject_upload', args: { p_document_id: DOC_ID, p_actor: ADMIN_ID } }]);
    await flush();
    expect(loaded.hookCalls).toEqual([]);
  });

  it('refuses any body key, a non-object body and malformed JSON with 400 before any function runs', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    for (const route of [loaded.approve, loaded.reject]) {
      for (const body of [{ actor: OTHER_ADMIN_ID }, { p_actor: OTHER_ADMIN_ID }, { documentId: DOC_P }, [1], 'text']) {
        const response = await route.POST(req(`/api/rag/admin/upload-approvals/${DOC_ID}/x`, { method: 'POST', body }), params(DOC_ID));
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect((await route.POST(req(`/api/rag/admin/upload-approvals/${DOC_ID}/x`, { method: 'POST', rawBody: '{not json' }), params(DOC_ID))).status).toBe(400);
      for (const id of ['not-a-uuid', '../etc', `${DOC_ID}x`]) {
        expect((await route.POST(req('/api/rag/admin/upload-approvals/x/x', { method: 'POST' }), params(id))).status, id).toBe(400);
      }
    }
    expect(approvalCalls()).toEqual([]);
  });

  it('maps not_pending and superseded_by_newer to 409, not_found and a foreign id to the same 404, and a database failure to 503 without its message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const approve = (id = DOC_ID) => loaded.approve.POST(req(`/api/rag/admin/upload-approvals/${id}/approve`, { method: 'POST' }), params(id));

    state.outcomes.rag_approve_upload = { data: null, error: { code: 'P0001', message: 'not_pending' } };
    const notPending = await approve();
    expect(notPending.status).toBe(409);
    expect(await notPending.json()).toEqual({ success: false, error: 'not_pending' });

    state.outcomes.rag_approve_upload = { data: null, error: { code: 'P0001', message: 'superseded_by_newer' } };
    const superseded = await approve();
    expect(superseded.status).toBe(409);
    expect(await superseded.json()).toEqual({ success: false, error: 'superseded_by_newer' });

    state.outcomes.rag_approve_upload = { data: null, error: { code: 'P0001', message: 'approve_failed: held' } };
    const failed = await approve();
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ success: false, error: 'approve_failed', reason: 'held' });

    state.outcomes.rag_approve_upload = { data: null, error: { code: 'P0001', message: 'not_found' } };
    const unknown = await approve();
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ success: false, error: 'Document not found' });

    state.rpcCalls = [];
    const foreign = await approve(DOC_P);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(unknownBody);
    const missing = await approve('00000000-0000-4000-8000-0000000016ff');
    expect(missing.status).toBe(404);
    expect(approvalCalls()).toEqual([]);

    state.outcomes.rag_reject_upload = { data: null, error: { code: 'XX000', message: 'connection reset: secret text' } };
    const broken = await loaded.reject.POST(req(`/api/rag/admin/upload-approvals/${DOC_ID}/reject`, { method: 'POST' }), params(DOC_ID));
    expect(broken.status).toBe(503);
    expect(JSON.stringify(await broken.json())).not.toContain('secret text');
    await flush();
    expect(loaded.hookCalls).toEqual([]);
  });

  it('keeps the route files on the shared guard and off direct RPC names', () => {
    for (const file of [
      'src/app/api/rag/admin/upload-approvals/route.ts',
      'src/app/api/rag/admin/upload-approvals/[id]/approve/route.ts',
      'src/app/api/rag/admin/upload-approvals/[id]/reject/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source).toContain("'@/lib/admin-route-auth'");
      expect(source).not.toMatch(/rag_(approve|reject|list_pending)_upload/);
      expect(source).toContain("from 'zod/v3'");
    }
  });
});

const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000016f1';
const DOC_O = '00000000-0000-4000-8000-0000000016d4';
const CONNECTION_O = 'connection-neutral-o';
const CONNECTION_P = 'connection-neutral-p';
const P_MEMBER_ID = '00000000-0000-4000-8000-0000000016f2';

describe('upload approval routes: organization admin admission (multi-tenant)', () => {
  beforeEach(() => {
    resetState();
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: MEMBER_ID, role: 'member' },
      { organization_id: ORG_O, user_id: UPLOADER_ID, role: 'member' },
      { organization_id: ORG_P, user_id: P_MEMBER_ID, role: 'owner' },
    ];
    state.tables.documents.push({ id: DOC_O, tenant_key: `o:${ORG_O}` });
    state.tables.rag_upload_approval_exemptions = [
      { id: EXEMPTION_ID, tenant_key: `o:${ORG_O}` },
      { id: '00000000-0000-4000-8000-0000000016e2', tenant_key: `o:${ORG_P}` },
    ];
    state.tables.nango_connections = [
      { connection_id: CONNECTION_O, provider: 'drive', user_id: MEMBER_ID },
      { connection_id: CONNECTION_P, provider: 'drive', user_id: P_MEMBER_ID },
    ];
    state.users[ORG_ADMIN_ID] = { id: ORG_ADMIN_ID, email: 'org-admin@example.invalid' };
    state.users[P_MEMBER_ID] = { id: P_MEMBER_ID, email: 'p-owner@example.invalid' };
    state.outcomes.rag_list_pending_uploads = { data: [{ ...PENDING_ROW, document_id: DOC_O, tenant_key: `o:${ORG_O}` }], error: null };
    state.outcomes.rag_upload_exemption_list = { data: [{ ...EXEMPTION_ROW, tenant_key: `o:${ORG_O}`, created_by: ORG_ADMIN_ID }], error: null };
    state.outcomes.rag_approve_upload = { data: [{ outcome: 'published', document_id: DOC_O, version: 2, superseded_document_id: null }], error: null };
    state.outcomes.rag_upload_exemption_add = {
      data: [{ outcome: 'added', id: EXEMPTION_ID, tenant_key: `o:${ORG_O}`, kind: 'uploader', ref: MEMBER_ID, created_by: ORG_ADMIN_ID, created_at: '2026-11-25T08:00:00.000Z' }],
      error: null,
    };
    state.outcomes.rag_upload_exemption_remove = { data: [{ outcome: 'removed', id: EXEMPTION_ID }], error: null };
    for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  });

  const list = (l: Loaded, org: string | null) => l.list.GET(req(`/api/rag/admin/upload-approvals${org ? `?organizationId=${org}` : ''}`));
  const approve = (l: Loaded, id: string, org: string | null) =>
    l.approve.POST(req(`/api/rag/admin/upload-approvals/${id}/approve${org ? `?organizationId=${org}` : ''}`, { method: 'POST' }), params(id));
  const reject = (l: Loaded, id: string, org: string | null) =>
    l.reject.POST(req(`/api/rag/admin/upload-approvals/${id}/reject${org ? `?organizationId=${org}` : ''}`, { method: 'POST' }), params(id));
  const exemptionsUrl = (org: string, extra = '') => `/api/rag/admin/upload-approvals/exemptions?organizationId=${org}${extra}`;

  it('admits an organization admin who is not in admin_users for that organization only, and lists that tenant only', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const response = await list(loaded, ORG_O);
    expect(response.status).toBe(200);
    expect((await response.json()).items.map((item: Row) => item.id)).toEqual([DOC_O]);
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_list_pending_uploads', args: { p_actor: ORG_ADMIN_ID, p_tenant_key: `o:${ORG_O}`, p_limit: 50, p_offset: 0 } });

    state.rpcCalls = [];
    const other = await list(loaded, ORG_P);
    expect(other.status).toBe(403);
    expect(other.headers.get('cache-control')).toBe('no-store');
    expect((await list(loaded, null)).status).toBe(403);
    expect((await list(loaded, 'not-a-uuid')).status).toBe(403);
    expect(approvalCalls()).toEqual([]);
  });

  it('admits an organization admin by bearer token as well', async () => {
    const loaded = await load();
    state.tokens = { 'token-org-admin': ORG_ADMIN_ID };
    expect((await loaded.list.GET(req(`/api/rag/admin/upload-approvals?organizationId=${ORG_O}`, { authorization: 'Bearer token-org-admin' }))).status).toBe(200);
  });

  it('denies a member of the organization and a user of another organization with the standard denial', async () => {
    const loaded = await load();
    for (const user of [MEMBER_ID, P_MEMBER_ID]) {
      state.session = { id: user };
      const response = await list(loaded, ORG_O);
      expect(response.status, user).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
      expect((await approve(loaded, DOC_O, ORG_O)).status).toBe(403);
    }
    expect(approvalCalls()).toEqual([]);
  });

  it('fails closed when the membership lookup fails', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    state.membershipFails = true;
    expect((await list(loaded, ORG_O)).status).toBe(503);
    expect((await approve(loaded, DOC_O, ORG_O)).status).toBe(503);
    expect(approvalCalls()).toEqual([]);
  });

  it('approves an upload of its organization with the verified user as the actor', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const response = await approve(loaded, DOC_O, ORG_O);
    expect(response.status).toBe(200);
    expect(approvalCalls()).toEqual([{ fn: 'rag_approve_upload', args: { p_document_id: DOC_O, p_actor: ORG_ADMIN_ID } }]);
    await flush();
    expect(loaded.hookCalls).toEqual([{ documentId: DOC_O, tenantKey: `o:${ORG_O}` }]);
  });

  it('answers the shared 404 for an upload of another organization or a personal workspace and runs no function', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    state.tables.documents.push({ id: DOC_ID, tenant_key: `u:${UPLOADER_ID}` });
    state.tables.documents = state.tables.documents.filter((row) => !(row.id === DOC_ID && row.tenant_key === 's:default'));
    for (const id of [DOC_P, DOC_ID]) {
      const approved = await approve(loaded, id, ORG_O);
      const rejected = await reject(loaded, id, ORG_O);
      expect(approved.status, id).toBe(404);
      expect(rejected.status, id).toBe(404);
      expect(await approved.json()).toEqual({ success: false, error: 'Document not found' });
    }
    expect(approvalCalls()).toEqual([]);
  });

  it('gives a deployment admin who does not administer the named organization 403 Forbidden', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await list(loaded, ORG_O);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
    expect(approvalCalls()).toEqual([]);
  });

  it('lists exemptions with the choices of the organization: its members and their connections', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const response = await loaded.exemptions.GET(req(exemptionsUrl(ORG_O)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.items).toEqual([
      {
        id: EXEMPTION_ID,
        kind: 'uploader',
        ref: MEMBER_ID,
        display: 'member@example.invalid',
        added_by: { id: ORG_ADMIN_ID, display: 'org-admin@example.invalid' },
        added_at: '2026-11-23T09:00:00.000Z',
      },
    ]);
    expect(body.total).toBe(1);
    expect(body.choices.connector).toEqual([{ ref: CONNECTION_O, display: `drive (${CONNECTION_O})` }]);
    expect(body.choices.uploader.map((choice: Row) => choice.ref).sort()).toEqual([MEMBER_ID, ORG_ADMIN_ID, UPLOADER_ID].sort());
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_upload_exemption_list', args: { p_actor: ORG_ADMIN_ID, p_tenant_key: `o:${ORG_O}`, p_limit: 50, p_offset: 0 } });
  });

  it('adds an exemption for a member or a connection of the organization, and refuses other refs, kinds and keys with 400', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const post = (body: unknown) => loaded.exemptions.POST(req(exemptionsUrl(ORG_O), { method: 'POST', body }));

    const added = await post({ kind: 'uploader', ref: MEMBER_ID });
    expect(added.status).toBe(201);
    expect((await added.json()).outcome).toBe('added');
    expect(approvalCalls()).toEqual([
      { fn: 'rag_upload_exemption_add', args: { p_actor: ORG_ADMIN_ID, p_tenant_key: `o:${ORG_O}`, p_kind: 'uploader', p_ref: MEMBER_ID } },
    ]);
    state.rpcCalls = [];
    expect((await post({ kind: 'connector', ref: CONNECTION_O })).status).toBe(201);
    expect(approvalCalls()[0]?.args).toMatchObject({ p_kind: 'connector', p_ref: CONNECTION_O });

    state.rpcCalls = [];
    for (const body of [{ kind: 'uploader', ref: P_MEMBER_ID }, { kind: 'connector', ref: CONNECTION_P }, { kind: 'uploader', ref: 'not-a-user' }]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ success: false, error: 'invalid_ref' });
    }
    for (const body of [{ kind: 'group', ref: MEMBER_ID }, { kind: 'uploader', ref: MEMBER_ID, actor: ADMIN_ID }, { kind: 'uploader' }, [1]]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(approvalCalls()).toEqual([]);
  });

  it('removes an exemption of the organization and answers 404 for another organization one', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const removed = await loaded.exemptions.DELETE(req(exemptionsUrl(ORG_O, `&id=${EXEMPTION_ID}`), { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ success: true, id: EXEMPTION_ID });
    expect(approvalCalls()).toEqual([{ fn: 'rag_upload_exemption_remove', args: { p_actor: ORG_ADMIN_ID, p_exemption_id: EXEMPTION_ID } }]);

    state.rpcCalls = [];
    const foreign = await loaded.exemptions.DELETE(req(exemptionsUrl(ORG_O, '&id=00000000-0000-4000-8000-0000000016e2'), { method: 'DELETE' }));
    expect(foreign.status).toBe(404);
    expect((await loaded.exemptions.DELETE(req(exemptionsUrl(ORG_O, '&id=bad'), { method: 'DELETE' }))).status).toBe(400);
    expect(approvalCalls()).toEqual([]);
  });

  it('denies a member on every exemptions method', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_ID };
    expect((await loaded.exemptions.GET(req(exemptionsUrl(ORG_O)))).status).toBe(403);
    expect((await loaded.exemptions.POST(req(exemptionsUrl(ORG_O), { method: 'POST', body: { kind: 'uploader', ref: MEMBER_ID } }))).status).toBe(403);
    expect((await loaded.exemptions.DELETE(req(exemptionsUrl(ORG_O, `&id=${EXEMPTION_ID}`), { method: 'DELETE' }))).status).toBe(403);
    expect(approvalCalls()).toEqual([]);
  });

  it('in single-tenant mode admits admin_users members only, whatever their organization role', async () => {
    state.mode = 'single-tenant';
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    expect((await list(loaded, ORG_O)).status).toBe(403);
    expect((await approve(loaded, DOC_ID, ORG_O)).status).toBe(403);
    expect(approvalCalls()).toEqual([]);
  });

  it('keeps all four route files on checkAdminOrOrgAdmin', () => {
    for (const file of [
      'src/app/api/rag/admin/upload-approvals/route.ts',
      'src/app/api/rag/admin/upload-approvals/[id]/approve/route.ts',
      'src/app/api/rag/admin/upload-approvals/[id]/reject/route.ts',
      'src/app/api/rag/admin/upload-approvals/exemptions/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).toContain('checkAdminOrOrgAdmin');
      expect(source, file).not.toMatch(/\bcheckAdmin\(/);
    }
  });
});
