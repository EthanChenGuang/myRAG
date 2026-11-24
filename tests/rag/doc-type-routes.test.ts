import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const ORG_Y = '00000000-0000-4000-8000-0000000000c2';
const DOC_ID = '00000000-0000-4000-8000-0000000000d1';
const REPO_ROOT = path.resolve(__dirname, '../..');

type Row = Record<string, unknown>;

interface DefaultRow {
  tenant_key: string;
  source_kind: string;
  source_ref: string | null;
  doc_type: string;
  updated_by: string;
  updated_at: string;
}

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  pipeline: 'unified',
  session: null as { id: string } | null,
  sessionThrows: false,
  lookupFails: false,
  tokens: {} as Record<string, string>,
  admins: [] as string[],
  members: [] as Array<{ organization_id: string; user_id: string }>,
  rows: [] as DefaultRow[],
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcFails: false,
  leakForeignRow: false,
};

function defaultRow(tenantKey: string, sourceKind: string, docType: string, sourceRef: string | null = null, updatedBy = ADMIN_ID): DefaultRow {
  return { tenant_key: tenantKey, source_kind: sourceKind, source_ref: sourceRef, doc_type: docType, updated_by: updatedBy, updated_at: '2026-11-24T10:00:00.000Z' };
}

function respond(data: Row[] | null, error: { code: string; message: string } | null = null): RpcRequest {
  const response: RpcResponse = { data, error };
  const request: RpcRequest = {
    abortSignal: () => request,
    then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
  };
  return request;
}

function fakeRpc(): RpcClient {
  return {
    rpc(fn, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      state.calls.push({ fn, args: a });
      if (state.rpcFails) return respond(null, { code: 'XX000', message: 'connection reset: secret-text-placeholder' });
      if (fn === 'rag_get_doc_type_defaults') {
        const own = state.rows.filter((row) => row.tenant_key === a.p_tenant_key);
        const source = a.p_source as string | null;
        const picked = own.filter((row) => {
          if (source === null) return true;
          if (row.source_kind === 'tenant') return true;
          if (row.source_kind === source && row.source_ref === null) return true;
          return row.source_kind === 'nango' && source === 'nango' && row.source_ref !== null && (row.source_ref === a.p_connection_id || row.source_ref === a.p_folder_id);
        });
        const leaked = state.leakForeignRow ? [defaultRow(`u:${USER_B}`, 'tenant', 'invoice_receipt')] : [];
        return respond([...picked, ...leaked] as unknown as Row[]);
      }
      if (fn === 'rag_set_doc_type_default') {
        const next = defaultRow(a.p_tenant_key as string, a.p_source_kind as string, a.p_doc_type as string, (a.p_source_ref as string | null) ?? null, a.p_updated_by as string);
        state.rows = state.rows.filter((row) => !(row.tenant_key === next.tenant_key && row.source_kind === next.source_kind && row.source_ref === next.source_ref));
        state.rows.push(next);
        return respond([next as unknown as Row]);
      }
      return respond([]);
    },
  };
}

function guardClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (table === 'admin_users') {
            if (state.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
            return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
          }
          if (table === 'organization_members') {
            const member = state.members.find((entry) => entry.organization_id === filters.organization_id && entry.user_id === filters.user_id);
            return Promise.resolve({ data: member ? { organization_id: member.organization_id } : null, error: null });
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
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
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => guardClient(), getSupabase: () => ({}) }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => fakeRpc(), ingestEnv: () => ({ RAG_INGEST_PIPELINE: state.pipeline }) });
  const session = await import('@/lib/admin-session');
  const picker = await import('@/app/api/rag/doc-type-defaults/route');
  const adminDefaults = await import('@/app/api/rag/admin/doc-type-defaults/route');
  return { session, picker, adminDefaults };
}

type Loaded = Awaited<ReturnType<typeof load>>;

interface ReqInit {
  method?: string;
  cookie?: string;
  authorization?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function req(url: string, init: ReqInit = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  return new Request(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const cookieOf = (value: string | null) => `admin_session=${value}`;
const defaultsCalls = () => state.calls.filter((call) => /doc_type_default/.test(call.fn));
const PICKER = '/api/rag/doc-type-defaults';
const ADMIN = '/api/rag/admin/doc-type-defaults';

let logged: string[] = [];

beforeEach(() => {
  state.mode = 'multi-tenant';
  state.pipeline = 'unified';
  state.session = null;
  state.sessionThrows = false;
  state.lookupFails = false;
  state.tokens = {};
  state.admins = [ADMIN_ID, OTHER_ADMIN_ID];
  state.members = [];
  state.rows = [];
  state.calls = [];
  state.rpcFails = false;
  state.leakForeignRow = false;
  logged = [];
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/deployment-mode');
});

describe('GET /api/rag/doc-type-defaults (the picker default)', () => {
  it.each(['multi-tenant', 'single-tenant'] as const)('answers 401 without a session in %s mode and reads no default', async (mode) => {
    state.mode = mode;
    const { picker } = await load();
    const response = await picker.GET(req(`${PICKER}?source=chat_upload`));
    expect(response.status).toBe(401);
    expect(defaultsCalls()).toEqual([]);
  });

  it('answers 503 when the session lookup throws', async () => {
    state.sessionThrows = true;
    const { picker } = await load();
    expect((await picker.GET(req(`${PICKER}?source=chat_upload`))).status).toBe(503);
    expect(defaultsCalls()).toEqual([]);
  });

  it('reports the picker as disabled under the legacy pipeline and reads no default', async () => {
    state.pipeline = 'legacy';
    state.session = { id: USER_A };
    state.rows = [defaultRow(`u:${USER_A}`, 'tenant', 'contract_legal')];
    const { picker } = await load();
    const response = await picker.GET(req(`${PICKER}?source=chat_upload`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(defaultsCalls()).toEqual([]);
  });

  it('resolves the order source default, tenant default, general for the verified scope', async () => {
    state.session = { id: USER_A };
    const { picker } = await load();

    const none = await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json();
    expect(none).toEqual({ enabled: true, docType: 'general', origin: 'fallback' });

    state.rows = [defaultRow(`u:${USER_A}`, 'tenant', 'financial_report')];
    const tenant = await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json();
    expect(tenant).toEqual({ enabled: true, docType: 'financial_report', origin: 'tenant_default' });

    state.rows.push(defaultRow(`u:${USER_A}`, 'chat_upload', 'contract_legal'));
    const source = await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json();
    expect(source).toEqual({ enabled: true, docType: 'contract_legal', origin: 'source_default' });

    const other = await (await picker.GET(req(`${PICKER}?source=config_upload`))).json();
    expect(other).toEqual({ enabled: true, docType: 'financial_report', origin: 'tenant_default' });
  });

  it('returns an auto default as auto', async () => {
    state.session = { id: USER_A };
    state.rows = [defaultRow(`u:${USER_A}`, 'chat_upload', 'auto')];
    const { picker } = await load();
    expect(await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json()).toEqual({ enabled: true, docType: 'auto', origin: 'source_default' });
  });

  it('honours an organization only through the membership check, and reads that organization tenant only', async () => {
    state.session = { id: USER_A };
    state.rows = [defaultRow(`o:${ORG_X}`, 'tenant', 'invoice_receipt'), defaultRow(`u:${USER_A}`, 'tenant', 'contract_legal')];
    const { picker } = await load();

    const notMember = await picker.GET(req(`${PICKER}?source=chat_upload&organizationId=${ORG_X}`));
    expect(notMember.status).toBe(403);
    expect(defaultsCalls()).toEqual([]);

    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const member = await picker.GET(req(`${PICKER}?source=chat_upload&organizationId=${ORG_X}`));
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({ enabled: true, docType: 'invoice_receipt', origin: 'tenant_default' });
    expect(defaultsCalls().at(-1)?.args.p_tenant_key).toBe(`o:${ORG_X}`);

    const personal = await picker.GET(req(`${PICKER}?source=chat_upload`));
    expect(await personal.json()).toEqual({ enabled: true, docType: 'contract_legal', origin: 'tenant_default' });
  });

  it('keeps two tenants apart in both modes: each caller reads only the default of their own tenant', async () => {
    state.rows = [defaultRow(`u:${USER_A}`, 'tenant', 'contract_legal'), defaultRow(`u:${USER_B}`, 'tenant', 'invoice_receipt'), defaultRow('s:default', 'tenant', 'financial_report')];
    const { picker } = await load();

    state.session = { id: USER_A };
    expect((await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json()).docType).toBe('contract_legal');
    state.session = { id: USER_B };
    expect((await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json()).docType).toBe('invoice_receipt');

    state.mode = 'single-tenant';
    const single = await load();
    state.session = { id: USER_A };
    expect(await (await single.picker.GET(req(`${PICKER}?source=chat_upload`))).json()).toEqual({ enabled: true, docType: 'financial_report', origin: 'tenant_default' });
    expect(defaultsCalls().at(-1)?.args.p_tenant_key).toBe('s:default');
  });

  it('drops a row that belongs to another tenant even when the database returns one', async () => {
    state.session = { id: USER_A };
    state.leakForeignRow = true;
    const { picker } = await load();
    expect(await (await picker.GET(req(`${PICKER}?source=chat_upload`))).json()).toEqual({ enabled: true, docType: 'general', origin: 'fallback' });
  });

  it('answers 400 for a missing or unknown source and 503, without the database message, when the read fails', async () => {
    state.session = { id: USER_A };
    const { picker } = await load();
    for (const query of ['', '?source=elsewhere', '?source=']) {
      const response = await picker.GET(req(`${PICKER}${query}`));
      expect(response.status, query).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    expect(defaultsCalls()).toEqual([]);

    state.rpcFails = true;
    const failed = await picker.GET(req(`${PICKER}?source=chat_upload`));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('secret-text-placeholder');
    expect(logged.join('\n')).not.toContain('secret-text-placeholder');
  });
});

describe('admin doc-type-defaults routes', () => {
  interface RouteCase {
    name: string;
    call: (loaded: Loaded, init?: ReqInit) => Promise<Response>;
    okStatus: number;
  }

  const ROUTES: RouteCase[] = [
    { name: 'GET /api/rag/admin/doc-type-defaults', call: (l, init) => l.adminDefaults.GET(req(ADMIN, init)), okStatus: 200 },
    {
      name: 'PUT /api/rag/admin/doc-type-defaults',
      call: (l, init) => l.adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { sourceKind: 'tenant', docType: 'contract_legal' }, ...init })),
      okStatus: 200,
    },
  ];

  describe.each(ROUTES)('$name fails closed', (route) => {
    it('without any credential gives 401 and touches no default', async () => {
      const loaded = await load();
      const response = await route.call(loaded);
      expect(response.status).toBe(401);
      expect((await response.json()).success).toBe(false);
      expect(state.calls).toEqual([]);
    });

    it('gives 503 when the auth lookup throws and when the admin_users lookup fails', async () => {
      const loaded = await load();
      state.sessionThrows = true;
      expect((await route.call(loaded)).status).toBe(503);
      state.sessionThrows = false;
      state.session = { id: ADMIN_ID };
      state.lookupFails = true;
      expect((await route.call(loaded)).status).toBe(503);
      expect(state.calls).toEqual([]);
    });

    it('gives 403 to a user outside admin_users, by session and by bearer token, also when they are a member of the organization', async () => {
      const loaded = await load();
      state.members = [{ organization_id: ORG_X, user_id: USER_A }];
      state.session = { id: USER_A };
      expect((await route.call(loaded)).status).toBe(403);
      state.session = null;
      state.tokens = { 'token-user': USER_A };
      expect((await route.call(loaded, { authorization: 'Bearer token-user' })).status).toBe(403);
      expect(state.calls).toEqual([]);
    });

    it('gives 401 to a forged or unsigned admin_session cookie and to a signed cookie without the matching live session', async () => {
      const loaded = await load();
      expect((await route.call(loaded, { cookie: cookieOf(ADMIN_ID) })).status).toBe(401);
      const signed = loaded.session.mintAdminSessionValue(ADMIN_ID) as string;
      const [id, expiry, signature] = signed.split('.');
      const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
      expect((await route.call(loaded, { cookie: cookieOf(`${id}.${expiry}.${flipped}`) })).status).toBe(401);
      expect((await route.call(loaded, { cookie: cookieOf(signed) })).status).toBe(401);
      expect(state.calls).toEqual([]);
    });

    it('gives 403 to a validly signed admin_session cookie of a user who is not in admin_users', async () => {
      const loaded = await load();
      state.session = { id: USER_A };
      const cookie = cookieOf(loaded.session.mintAdminSessionValue(USER_A));
      expect((await route.call(loaded, { cookie })).status).toBe(403);
      expect(state.calls).toEqual([]);
    });

    it('admits a signed admin_session cookie with its live session, and a bearer token of an admin', async () => {
      const loaded = await load();
      state.session = { id: ADMIN_ID };
      const cookie = cookieOf(loaded.session.mintAdminSessionValue(ADMIN_ID));
      expect((await route.call(loaded, { cookie })).status).toBe(route.okStatus);
      state.session = null;
      state.tokens = { 'token-admin': ADMIN_ID };
      expect((await route.call(loaded, { authorization: 'Bearer token-admin' })).status).toBe(route.okStatus);
      expect(defaultsCalls()).toHaveLength(2);
    });
  });

  it('lists the defaults of the admin own workspace and nothing of another tenant, in multi-tenant mode', async () => {
    state.session = { id: ADMIN_ID };
    state.members = [{ organization_id: ORG_X, user_id: ADMIN_ID }];
    state.rows = [
      defaultRow(`u:${ADMIN_ID}`, 'tenant', 'financial_report'),
      defaultRow(`o:${ORG_X}`, 'chat_upload', 'invoice_receipt'),
      defaultRow(`u:${USER_A}`, 'tenant', 'contract_legal'),
      defaultRow(`o:${ORG_Y}`, 'tenant', 'scanned_image'),
    ];
    const { adminDefaults } = await load();

    const personal = await (await adminDefaults.GET(req(ADMIN))).json();
    expect(personal.success).toBe(true);
    expect(personal.items).toEqual([{ source_kind: 'tenant', source_ref: null, doc_type: 'financial_report', updated_by: ADMIN_ID, updated_at: '2026-11-24T10:00:00.000Z' }]);

    const org = await (await adminDefaults.GET(req(`${ADMIN}?organizationId=${ORG_X}`))).json();
    expect(org.items.map((item: Row) => `${item.source_kind}:${item.doc_type}`)).toEqual(['chat_upload:invoice_receipt']);
    expect(defaultsCalls().map((call) => call.args.p_tenant_key)).toEqual([`u:${ADMIN_ID}`, `o:${ORG_X}`]);

    const foreign = await adminDefaults.GET(req(`${ADMIN}?organizationId=${ORG_Y}`));
    expect(foreign.status).toBe(403);
    expect(defaultsCalls()).toHaveLength(2);
  });

  it('lists the single tenant defaults in single-tenant mode', async () => {
    state.mode = 'single-tenant';
    state.session = { id: ADMIN_ID };
    state.rows = [defaultRow('s:default', 'tenant', 'general'), defaultRow(`u:${USER_A}`, 'tenant', 'contract_legal')];
    const { adminDefaults } = await load();
    const body = await (await adminDefaults.GET(req(ADMIN))).json();
    expect(body.items).toHaveLength(1);
    expect(defaultsCalls()[0]?.args.p_tenant_key).toBe('s:default');
  });

  it('sets a default with updated_by taken from the verified admin, never from the body or a header', async () => {
    state.session = { id: ADMIN_ID };
    const { adminDefaults } = await load();
    const response = await adminDefaults.PUT(
      req(ADMIN, { method: 'PUT', body: { sourceKind: 'chat_upload', docType: 'auto' }, headers: { 'x-actor-id': OTHER_ADMIN_ID, 'x-user-id': OTHER_ADMIN_ID } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      item: { source_kind: 'chat_upload', source_ref: null, doc_type: 'auto', updated_by: ADMIN_ID, updated_at: expect.any(String) },
    });
    expect(defaultsCalls()).toEqual([
      { fn: 'rag_set_doc_type_default', args: { p_tenant_key: `u:${ADMIN_ID}`, p_source_kind: 'chat_upload', p_source_ref: null, p_doc_type: 'auto', p_updated_by: ADMIN_ID } },
    ]);
    expect(logged.some((line) => line.includes('[RAG Admin]'))).toBe(true);

    const withActor = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { sourceKind: 'tenant', docType: 'general', updatedBy: OTHER_ADMIN_ID } }));
    expect(withActor.status).toBe(400);
    expect(defaultsCalls()).toHaveLength(1);
  });

  it('refuses an invalid type, source kind, reference or body with 400 before any write', async () => {
    state.session = { id: ADMIN_ID };
    const { adminDefaults } = await load();
    const bodies: unknown[] = [
      { sourceKind: 'tenant', docType: 'memo' },
      { sourceKind: 'elsewhere', docType: 'general' },
      { sourceKind: 'chat_upload', sourceRef: 'conn-1', docType: 'general' },
      { sourceKind: 'nango', sourceRef: '   ', docType: 'general' },
      { sourceKind: 'tenant' },
      { docType: 'general' },
      [1],
      'text',
    ];
    for (const body of bodies) {
      const response = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    const malformed = new Request(`http://localhost${ADMIN}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect((await adminDefaults.PUT(malformed)).status).toBe(400);
    expect(defaultsCalls()).toEqual([]);
  });

  it('sets a Nango connection default and an organization default only for a workspace the admin belongs to', async () => {
    state.session = { id: ADMIN_ID };
    state.members = [{ organization_id: ORG_X, user_id: ADMIN_ID }];
    state.rows = [defaultRow(`o:${ORG_Y}`, 'tenant', 'scanned_image')];
    const { adminDefaults } = await load();

    const nango = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { sourceKind: 'nango', sourceRef: 'conn-1', docType: 'financial_report' } }));
    expect(nango.status).toBe(200);
    expect(defaultsCalls()[0]?.args).toMatchObject({ p_tenant_key: `u:${ADMIN_ID}`, p_source_kind: 'nango', p_source_ref: 'conn-1' });

    const member = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { organizationId: ORG_X, sourceKind: 'tenant', docType: 'contract_legal' } }));
    expect(member.status).toBe(200);
    expect(defaultsCalls().at(-1)?.args.p_tenant_key).toBe(`o:${ORG_X}`);

    const before = defaultsCalls().length;
    const foreign = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { organizationId: ORG_Y, sourceKind: 'tenant', docType: 'general' } }));
    expect(foreign.status).toBe(403);
    expect(defaultsCalls()).toHaveLength(before);
    expect(state.rows.find((row) => row.tenant_key === `o:${ORG_Y}`)?.doc_type).toBe('scanned_image');
  });

  it('writes the single tenant default in single-tenant mode and ignores an organization id', async () => {
    state.mode = 'single-tenant';
    state.session = { id: ADMIN_ID };
    const { adminDefaults } = await load();
    const response = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { organizationId: ORG_Y, sourceKind: 'tenant', docType: 'product_technical' } }));
    expect(response.status).toBe(200);
    expect(defaultsCalls()[0]?.args.p_tenant_key).toBe('s:default');
  });

  it('answers 503 without the database message when the write fails', async () => {
    state.session = { id: ADMIN_ID };
    const { adminDefaults } = await load();
    state.rpcFails = true;
    const response = await adminDefaults.PUT(req(ADMIN, { method: 'PUT', body: { sourceKind: 'tenant', docType: 'general' } }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret-text-placeholder');
  });

  it('keeps the admin route on the shared guard: checkAdmin from admin-route-auth, never the Bearer guard directly, zod/v3, no direct RPC name', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/rag/admin/doc-type-defaults/route.ts'), 'utf8');
    expect(source).toMatch(/\bcheckAdmin\b/);
    expect(source).toContain("'@/lib/admin-route-auth'");
    expect(source).not.toContain('requireRagAdmin');
    expect(source).not.toMatch(/rag_(get|set|delete)_doc_type_default/);
    expect(source).toContain("from 'zod/v3'");
  });
});

const DOC_TYPE_CHANGE = `/api/rag/admin/documents/${DOC_ID}/doc-type`;

type ChangeOutcome =
  | { ok: true; result: { status: 'ready' | 'processing'; documentId: string; version: number } }
  | { ok: false; reason: string };

const changeState = {
  scope: null as { kind: 'personal'; userId: string; organizationId: null } | null,
  scopeError: null as 'unavailable' | 'not_admin' | null,
  change: { ok: true, result: { status: 'ready' as const, documentId: DOC_ID, version: 2 } } as ChangeOutcome,
  changeCalls: [] as Array<{ documentId: string; docType: string }>,
  scopeCalls: [] as string[],
};

async function loadDocTypeChange() {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
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
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => guardClient(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    class MockAdminDocumentScopeError extends Error {
      readonly reason: 'unavailable' | 'not_admin';
      constructor(reason: 'unavailable' | 'not_admin') {
        super(reason);
        this.reason = reason;
      }
    }
    return {
      ...actual,
      AdminDocumentScopeError: MockAdminDocumentScopeError,
      scopeForAdminDocument: async (input: { documentId: string }) => {
        changeState.scopeCalls.push(input.documentId);
        if (changeState.scopeError === 'unavailable') throw new MockAdminDocumentScopeError('unavailable');
        if (changeState.scopeError === 'not_admin') throw new MockAdminDocumentScopeError('not_admin');
        return changeState.scope;
      },
      changeDocumentType: async (input: { documentId: string; docType: string }) => {
        changeState.changeCalls.push({ documentId: input.documentId, docType: input.docType });
        return changeState.change;
      },
    };
  });
  const session = await import('@/lib/admin-session');
  const route = await import('@/app/api/rag/admin/documents/[id]/doc-type/route');
  return { session, route };
}

describe('POST /api/rag/admin/documents/{id}/doc-type', () => {
  beforeEach(() => {
    changeState.scope = { kind: 'personal', userId: ADMIN_ID, organizationId: null };
    changeState.scopeError = null;
    changeState.change = { ok: true, result: { status: 'ready', documentId: DOC_ID, version: 2 } };
    changeState.changeCalls = [];
    changeState.scopeCalls = [];
  });

  it('changes the type and returns 200 when the new version is ready', async () => {
    state.session = { id: ADMIN_ID };
    const { route } = await loadDocTypeChange();
    const response = await route.POST(
      req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'contract_legal' } }),
      { params: Promise.resolve({ id: DOC_ID }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: DOC_ID, status: 'ready', version: 2 });
    expect(changeState.changeCalls).toEqual([{ documentId: DOC_ID, docType: 'contract_legal' }]);
    expect(logged.some((line) => line.includes('[RAG Admin]') && line.includes('doc_type_change'))).toBe(true);
  });

  it('returns 202 when the new version is still processing', async () => {
    state.session = { id: ADMIN_ID };
    changeState.change = { ok: true, result: { status: 'processing', documentId: DOC_ID, version: 2 } };
    const { route } = await loadDocTypeChange();
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(202);
  });

  it.each([
    ['memo', 400],
    ['', 400],
    [{ extra: 'general' }, 400],
  ] as const)('refuses invalid body %o with %i', async (body, status) => {
    state.session = { id: ADMIN_ID };
    const { route } = await loadDocTypeChange();
    const response = await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body }), { params: Promise.resolve({ id: DOC_ID }) });
    expect(response.status).toBe(status);
    expect(changeState.changeCalls).toEqual([]);
    expect(changeState.scopeCalls).toEqual([]);
  });

  it('gives 404 for an unknown document and never calls changeDocumentType', async () => {
    state.session = { id: ADMIN_ID };
    changeState.scope = null;
    const { route } = await loadDocTypeChange();
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(404);
    expect(changeState.changeCalls).toEqual([]);
  });

  it('gives 403 without a session, to a non-admin, and when scope refuses the actor', async () => {
    const { route } = await loadDocTypeChange();
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(401);
    state.session = { id: USER_A };
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(403);
    state.session = { id: ADMIN_ID };
    changeState.scopeError = 'not_admin';
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(403);
    expect(changeState.changeCalls).toEqual([]);
  });

  it('gives 503 when auth or scope lookup fails and when change is unavailable', async () => {
    const { route } = await loadDocTypeChange();
    state.sessionThrows = true;
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(503);
    state.sessionThrows = false;
    state.session = { id: ADMIN_ID };
    state.lookupFails = true;
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(503);
    state.lookupFails = false;
    changeState.scopeError = 'unavailable';
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(503);
    changeState.scopeError = null;
    changeState.change = { ok: false, reason: 'unavailable' };
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(503);
  });

  it('admits a signed admin_session cookie and never runs change before the guard passes', async () => {
    const { session, route } = await loadDocTypeChange();
    state.session = { id: ADMIN_ID };
    const cookie = cookieOf(session.mintAdminSessionValue(ADMIN_ID));
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', cookie, body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(200);
    state.session = { id: USER_A };
    expect((await route.POST(req(DOC_TYPE_CHANGE, { method: 'POST', cookie: cookieOf(session.mintAdminSessionValue(USER_A)), body: { docType: 'general' } }), { params: Promise.resolve({ id: DOC_ID }) })).status).toBe(403);
    expect(changeState.scopeCalls.length).toBe(1);
  });

  it('keeps checkAdmin and changeDocumentType on the shared path and never requireRagAdmin', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/app/api/rag/admin/documents/[id]/doc-type/route.ts'), 'utf8');
    expect(source).toMatch(/\bcheckAdmin\b/);
    expect(source).toMatch(/\bchangeDocumentType\b/);
    expect(source).not.toContain('requireRagAdmin');
    expect(source).toContain("from 'zod/v3'");
  });
});
