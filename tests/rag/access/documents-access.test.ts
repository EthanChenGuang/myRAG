import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000000a0';
const MEMBER_A = '00000000-0000-4000-8000-0000000000a2';
const OUTSIDER = '00000000-0000-4000-8000-0000000000a3';
const GROUP_A = '00000000-0000-4000-8000-0000000000f1';
const DOC_OPEN = '00000000-0000-4000-8000-00000000d001';
const DOC_RESTRICTED = '00000000-0000-4000-8000-00000000d002';
const DOC_MISSING = '00000000-0000-4000-8000-00000000dfff';
const IMAGE_OPEN = '00000000-0000-4000-8000-00000000d011';
const IMAGE_RESTRICTED = '00000000-0000-4000-8000-00000000d012';
const SCRAPE_URL = 'https://example.org/page-a';

type Row = Record<string, unknown>;
type Filter = [op: 'eq' | 'neq' | 'in' | 'is' | 'overlaps', column: string, value: unknown];

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  access: 'on' as 'on' | 'off',
  session: null as string | null,
  admins: [] as string[],
  memberships: new Map<string, string[]>(),
  tables: {} as Record<string, Row[]>,
  failRpc: null as string | null,
  rpcCalls: [] as string[],
  selects: [] as Array<{ table: string; columns: string; filters: Filter[] }>,
};

function read(row: Row, column: string): unknown {
  if (column === 'lineage_id') return row.lineage_id ?? row.id;
  if (column === 'is_current') return row.is_current ?? true;
  if (column === 'status') return row.status ?? 'ready';
  if (column === 'tenant_key') return row.tenant_key ?? 's:default';
  if (column === 'access_groups') return row.access_groups ?? ['all'];
  if (column === 'version') return row.version ?? 1;
  return row[column];
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(([op, column, value]) => {
    const actual = read(row, column);
    if (op === 'in') return (value as unknown[]).includes(actual);
    if (op === 'is') return (actual ?? null) === value;
    if (op === 'neq') return actual !== value;
    if (op === 'overlaps') return (actual as string[]).some((key) => (value as string[]).includes(key));
    return actual === value;
  });
}

function project(row: Row, columns: string): Row {
  if (columns === '*') return { ...row };
  const out: Row = {};
  for (const column of columns.split(',').map((name) => name.trim())) out[column] = read(row, column);
  return out;
}

function table(name: string) {
  state.tables[name] ??= [];
  const rows = state.tables[name];
  const filters: Filter[] = [];
  let columns = '*';
  let head = false;
  const selected = () => rows.filter((row) => matches(row, filters));
  let update: Row | null = null;
  const run = () => {
    if (update) {
      const next = update;
      selected().forEach((row) => Object.assign(row, next));
      return { data: null, error: null };
    }
    state.selects.push({ table: name, columns, filters: [...filters] });
    if (head) return { data: null, count: selected().length, error: null };
    return { data: selected().map((row) => project(row, columns)), error: null };
  };
  const builder: Record<string, unknown> = {
    select(cols = '*', options?: { head?: boolean }) {
      columns = cols;
      head = options?.head === true;
      return builder;
    },
    abortSignal: () => builder,
    order: () => builder,
    limit: () => builder,
    update(next: Row) {
      update = next;
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push(['eq', column, value]);
      return builder;
    },
    neq(column: string, value: unknown) {
      filters.push(['neq', column, value]);
      return builder;
    },
    in(column: string, value: unknown[]) {
      filters.push(['in', column, value]);
      return builder;
    },
    is(column: string, value: unknown) {
      filters.push(['is', column, value]);
      return builder;
    },
    overlaps(column: string, value: string[]) {
      filters.push(['overlaps', column, value]);
      return builder;
    },
    maybeSingle: async () => {
      const result = run();
      return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : null, error: null };
    },
    then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return builder;
}

function rpcRequest(respond: () => unknown) {
  const request = {
    abortSignal: () => request,
    then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve().then(respond).then(ok, bad),
  };
  return request;
}

const admin = {
  from: (name: string) => table(name),
  rpc(fn: string, args: Row) {
    state.rpcCalls.push(fn);
    return rpcRequest(() => {
      if (state.failRpc === fn) return { data: null, error: { code: 'XX000', message: 'down' } };
      if (fn === 'rag_resolve_access_scope') {
        const userId = String(args.p_user_id);
        const groups = state.memberships.get(userId) ?? [];
        return {
          data: [{ is_admin: state.admins.includes(userId), group_ids: groups, effective_keys: ['all', ...groups.map((id) => `g:${id}`)] }],
          error: null,
        };
      }
      if (fn === 'rag_access_document_audience') {
        const ids = args.p_document_ids as string[];
        const docs = (state.tables.documents ?? []).filter((doc) => ids.includes(String(doc.id)) && read(doc, 'is_current') === true);
        return {
          data: docs.map((doc) => {
            const restricted = (read(doc, 'access_groups') as string[])[0] !== 'all';
            return {
              document_id: doc.id,
              filename: doc.filename,
              kind: restricted ? 'groups' : 'everyone',
              group_ids: restricted ? [GROUP_A] : [],
              group_names: restricted ? ['group-a'] : [],
              people_count: 0,
              fallback_reason: null,
              connector_managed: doc.source === 'nango',
            };
          }),
          error: null,
        };
      }
      if (fn === 'rag_documents_visible') {
        const keys = (args.p_access_keys as string[] | undefined) ?? [];
        const ids = args.p_document_ids as string[];
        const visible = (state.tables.documents ?? []).filter(
          (doc) =>
            ids.includes(String(doc.id)) &&
            read(doc, 'tenant_key') === args.p_tenant_key &&
            (args.p_access_all === true || (read(doc, 'access_groups') as string[]).some((key) => keys.includes(key))),
        );
        return { data: visible.map((doc) => doc.id), error: null };
      }
      return { data: [], error: null };
    });
  },
};

async function load<T>(path: string): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: state.session ? { id: state.session } : null }, error: null }) },
    }),
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: true }) }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin }));
  vi.doMock('@/lib/rag/tenant/access-startup', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rag/tenant/access-startup')>()),
    accessReadyForResolve: async () => true,
  }));
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => admin as never, ragEnv: () => ({ RAG_DOC_ACCESS_GROUPS: state.access }) });
  return (await import(path)) as T;
}

type ListRoute = { GET: (request: NextRequest) => Promise<Response> };
type IdRoute = {
  DELETE: (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  PATCH: (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};

async function list(query = ''): Promise<{ status: number; body: Row }> {
  const route = await load<ListRoute>('@/app/api/documents/route');
  const response = await route.GET(new NextRequest(`http://localhost/api/documents${query}`));
  return { status: response.status, body: (await response.json()) as Row };
}

async function byId(method: 'DELETE' | 'PATCH', id: string): Promise<{ status: number; body: Row }> {
  const route = await load<IdRoute>('@/app/api/documents/[id]/route');
  const request = new NextRequest(`http://localhost/api/documents/${id}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'PATCH' ? { body: JSON.stringify({ external_url: 'https://example.org/link-a' }) } : {}),
  });
  const response = await route[method](request, { params: Promise.resolve({ id }) });
  return { status: response.status, body: (await response.json()) as Row };
}

const docIds = (body: Row) => (body.documents as Row[]).map((doc) => doc.id);

beforeEach(() => {
  state.mode = 'single-tenant';
  state.access = 'on';
  state.session = OUTSIDER;
  state.admins = [ADMIN];
  state.memberships = new Map([[MEMBER_A, [GROUP_A]]]);
  state.failRpc = null;
  state.rpcCalls = [];
  state.selects = [];
  state.tables = {
    documents: [
      { id: DOC_OPEN, filename: 'document-a.pdf', created_at: '2026-01-02T00:00:00Z', metadata: {}, user_id: MEMBER_A },
      {
        id: DOC_RESTRICTED,
        filename: 'document-b.pdf',
        created_at: '2026-01-01T00:00:00Z',
        metadata: {},
        user_id: MEMBER_A,
        access_groups: [`g:${GROUP_A}`],
        source: 'nango',
      },
      { id: IMAGE_OPEN, filename: 'image-a.png', created_at: '2026-01-03T00:00:00Z', metadata: {} },
      { id: IMAGE_RESTRICTED, filename: 'image-b.png', created_at: '2026-01-04T00:00:00Z', metadata: {}, access_groups: [`g:${GROUP_A}`] },
    ],
    document_chunks: [
      { id: 'c1', document_id: DOC_OPEN },
      { id: 'c2', document_id: DOC_RESTRICTED },
      { id: 'c3', document_id: IMAGE_OPEN, metadata: { image_url: 'https://storage.example.org/chat-images/image-a.png' } },
      { id: 'c4', document_id: IMAGE_RESTRICTED, metadata: { image_url: 'https://storage.example.org/chat-images/image-b.png' } },
    ],
    admin_users: [{ id: ADMIN }],
    admin_settings: [{ read_only_doc_dashboard: false }],
  };
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  const { resetRagDepsForTests } = await import('@/lib/rag/deps');
  resetRagDepsForTests();
  vi.restoreAllMocks();
});

describe('GET /api/documents (D-15, UI-SPEC decision 6)', () => {
  it("leaves the restricted document out of an outsider's list, which then equals a list without it", async () => {
    const outsider = await list();
    expect(outsider.status).toBe(200);
    expect(docIds(outsider.body)).toEqual([DOC_OPEN]);
    const docs = outsider.body.documents as Row[];
    expect(docs[0]).toMatchObject({ id: DOC_OPEN, restricted: false, chunk_count: 1 });
    expect(docs[0]).not.toHaveProperty('audience');
    expect(docs[0]).not.toHaveProperty('access_groups');

    state.tables.documents = state.tables.documents.filter((doc) => doc.id !== DOC_RESTRICTED);
    expect(await list()).toEqual(outsider);
  });

  it('gives a member the restricted document with restricted: true and no group names', async () => {
    state.session = MEMBER_A;
    const result = await list();
    expect(docIds(result.body)).toEqual([DOC_OPEN, DOC_RESTRICTED]);
    const restricted = (result.body.documents as Row[])[1];
    expect(restricted).toMatchObject({ restricted: true });
    expect(JSON.stringify(result.body)).not.toContain('group-a');
    expect(restricted).not.toHaveProperty('audience');
  });

  it('gives an access admin the audience view and the connector-managed flag', async () => {
    state.session = ADMIN;
    const result = await list();
    const [open, restricted] = result.body.documents as Row[];
    expect(open).toMatchObject({ restricted: false, audience: { kind: 'everyone', groups: [] }, connectorManaged: false });
    expect(restricted).toMatchObject({
      restricted: true,
      audience: { kind: 'groups', groups: [{ id: GROUP_A, name: 'group-a' }], peopleCount: 0, fallbackReason: null },
      connectorManaged: true,
    });
  });

  it('shows an empty list, not an error, when every document is hidden', async () => {
    state.tables.documents = state.tables.documents.filter((doc) => doc.id === DOC_RESTRICTED);
    expect(await list()).toEqual({ status: 200, body: { documents: [] } });
  });

  it('applies the filter in multi-tenant mode for a workspace member', async () => {
    state.mode = 'multi-tenant';
    const org = '00000000-0000-4000-8000-0000000000c1';
    state.tables.organization_members = [{ organization_id: org, user_id: OUTSIDER }];
    for (const doc of state.tables.documents) Object.assign(doc, { organization_id: org, tenant_key: `o:${org}` });
    expect(docIds((await list(`?organization_id=${org}`)).body)).toEqual([DOC_OPEN]);
  });

  it('fails closed with 503 when the access lookup fails', async () => {
    state.failRpc = 'rag_resolve_access_scope';
    expect(await list()).toEqual({ status: 503, body: { error: 'access_groups_unavailable' } });
  });

  it('switch off: the list and its fields equal today (no restricted, audience or label field)', async () => {
    state.access = 'off';
    const result = await list();
    expect(docIds(result.body)).toEqual([DOC_OPEN, DOC_RESTRICTED]);
    for (const doc of result.body.documents as Row[]) {
      expect(doc).not.toHaveProperty('restricted');
      expect(doc).not.toHaveProperty('access_groups');
    }
    expect(state.rpcCalls).toEqual([]);
    expect(state.selects.filter((select) => select.table === 'documents').every((select) => !select.columns.includes('access_groups'))).toBe(true);
  });
});

describe('DELETE and PATCH /api/documents/[id] (D-15)', () => {
  it('answers a hidden id exactly like an unknown id and changes nothing', async () => {
    state.session = ADMIN;
    state.admins = [];
    state.tables.admin_users = [{ id: ADMIN }];
    const before = JSON.stringify(state.tables.documents);
    for (const method of ['DELETE', 'PATCH'] as const) {
      const unknown = await byId(method, DOC_MISSING);
      expect(unknown.status).toBe(404);
      expect(await byId(method, DOC_RESTRICTED)).toEqual(unknown);
    }
    expect(JSON.stringify(state.tables.documents)).toBe(before);
  });

  it('lets an access admin patch the restricted document', async () => {
    state.session = ADMIN;
    expect(await byId('PATCH', DOC_RESTRICTED)).toEqual({ status: 200, body: { success: true } });
  });

  it('switch off: the same request reaches the document as today', async () => {
    state.access = 'off';
    state.session = ADMIN;
    state.admins = [];
    expect(await byId('PATCH', DOC_RESTRICTED)).toEqual({ status: 200, body: { success: true } });
    expect(state.rpcCalls).toEqual([]);
  });
});
