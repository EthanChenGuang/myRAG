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
  return { list, approve, reject, hookCalls };
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
