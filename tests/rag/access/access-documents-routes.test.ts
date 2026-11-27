import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_ID = '00000000-0000-4000-8000-0000000024a1';
const ORG_ADMIN_ID = '00000000-0000-4000-8000-0000000024a2';
const MEMBER_A = '00000000-0000-4000-8000-0000000024b1';
const ORG_O = '00000000-0000-4000-8000-0000000024c1';
const GROUP_A = '00000000-0000-4000-8000-0000000024d1';
const GROUP_GONE = '00000000-0000-4000-8000-0000000024d9';
const DOC_1 = '00000000-0000-4000-8000-0000000024e1';
const DOC_2 = '00000000-0000-4000-8000-0000000024e2';
const DOC_3 = '00000000-0000-4000-8000-0000000024e3';
const DOC_CONNECTOR = '00000000-0000-4000-8000-0000000024e4';
const DOC_OTHER = '00000000-0000-4000-8000-0000000024e5';

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };

const state = {
  mode: 'single-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  tables: {} as Record<string, Row[]>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  outcomes: {} as Record<string, RpcOutcome | ((_args: Record<string, unknown>) => RpcOutcome)>,
};

function query(table: string) {
  const filters: Array<(_row: Row) => boolean> = [];
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
    then(onFulfilled: (_value: unknown) => unknown, onRejected?: (_reason: unknown) => unknown) {
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
    },
    from: (table: string) => query(table),
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const configured = state.outcomes[fn];
      const outcome = typeof configured === 'function' ? configured(args) : (configured ?? { data: [], error: null });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (_value: RpcOutcome) => unknown, onRejected?: (_reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
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
  const documents = await import('@/app/api/rag/access-groups/documents/route');
  const access = await import('@/app/api/rag/access-groups/documents/access/route');
  const status = await import('@/app/api/rag/access-groups/status/route');
  const sync = await import('@/app/api/rag/access-groups/status/sync/route');
  const drift = await import('@/app/api/rag/access-groups/drift/route');
  return { documents, access, status, sync, drift };
}

function req(url: string, init: { method?: string; authorization?: string; body?: unknown; rawBody?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.authorization) headers.authorization = init.authorization;
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}


type Doc = { id: string; tenant: string; filename: string; keys: string[]; connector: boolean; source: string };
const GROUP_NAMES: Record<string, string> = { [GROUP_A]: 'Group A' };
let docs: Doc[] = [];

function audienceRow(doc: Doc): Row {
  const groupIds = doc.keys.filter((key) => key.startsWith('g:')).map((key) => key.slice(2));
  const kind = doc.keys.includes('all') ? 'everyone' : groupIds.length > 0 ? 'groups' : 'uploader_only';
  return {
    document_id: doc.id,
    filename: doc.filename,
    doc_type: 'general',
    status: 'ready',
    created_at: '2026-11-27T08:00:00.000Z',
    kind,
    group_ids: groupIds,
    group_names: groupIds.map((id) => GROUP_NAMES[id] ?? null),
    people_count: groupIds.length * 2,
    fallback_reason: kind === 'uploader_only' && doc.connector ? 'unmapped_source_group' : null,
    connector_managed: doc.connector,
    source: doc.source,
    cursor: `Y3Vyc29y${doc.id.slice(-2)}`,
  };
}

const kindOf = (doc: Doc) => String(audienceRow(doc).kind);
const filterMatch = (filter: string) => (doc: Doc) =>
  filter === 'all' || (filter === 'restricted' ? kindOf(doc) === 'groups' : filter === 'everyone' ? kindOf(doc) === 'everyone' : kindOf(doc) === 'uploader_only');

function resetState() {
  state.mode = 'single-tenant';
  state.session = null;
  state.tokens = {};
  state.rpcCalls = [];
  state.tables = { admin_users: [{ id: ADMIN_ID }], organization_members: [] };
  docs = [
    { id: DOC_1, tenant: 's:default', filename: 'document-a.pdf', keys: ['all'], connector: false, source: 'upload' },
    { id: DOC_2, tenant: 's:default', filename: 'document-b.pdf', keys: ['all'], connector: false, source: 'upload' },
    { id: DOC_3, tenant: 's:default', filename: 'document-c.pdf', keys: ['all'], connector: false, source: 'upload' },
    { id: DOC_CONNECTOR, tenant: 's:default', filename: 'document-d.pdf', keys: [], connector: true, source: 'google-drive' },
    { id: DOC_OTHER, tenant: `o:${ORG_O}`, filename: 'document-e.pdf', keys: ['all'], connector: false, source: 'upload' },
  ];
  state.outcomes = {
    rag_set_document_access_groups: (args) => {
      const keys = args.p_keys as string[];
      const unknown = keys.find((key) => key.startsWith('g:') && !(key.slice(2) in GROUP_NAMES));
      if (unknown) return { data: null, error: { code: '22023', message: 'unknown_group' } };
      const rows = (args.p_document_ids as string[]).map((id) => {
        const doc = docs.find((item) => item.id === id && item.tenant === args.p_tenant_key);
        if (!doc) return { document_id: id, outcome: 'not_found', after_groups: [] };
        if (doc.connector) return { document_id: id, outcome: 'skipped_connector', after_groups: doc.keys };
        if (doc.keys.join() === keys.join()) return { document_id: id, outcome: 'unchanged', after_groups: doc.keys };
        doc.keys = [...keys];
        return { document_id: id, outcome: 'changed', after_groups: doc.keys };
      });
      return { data: rows, error: null };
    },
    rag_access_document_audience: (args) => ({
      data: docs.filter((doc) => doc.tenant === args.p_tenant_key && (args.p_document_ids as string[]).includes(doc.id)).map(audienceRow),
      error: null,
    }),
    rag_access_documents_list: (args) => ({
      data: docs
        .filter((doc) => doc.tenant === args.p_tenant_key)
        .filter(filterMatch(String(args.p_filter)))
        .filter((doc) => !args.p_query || doc.filename.includes(String(args.p_query)))
        .slice(0, Number(args.p_limit))
        .map(audienceRow),
      error: null,
    }),
    rag_access_documents_counts: (args) => {
      const own = docs.filter((doc) => doc.tenant === args.p_tenant_key).filter((doc) => !args.p_query || doc.filename.includes(String(args.p_query)));
      return {
        data: [
          {
            restricted: own.filter(filterMatch('restricted')).length,
            uploader_only: own.filter(filterMatch('uploader_only')).length,
            everyone: own.filter(filterMatch('everyone')).length,
            all: own.length,
          },
        ],
        error: null,
      };
    },
  };
}

beforeEach(() => {
  resetState();
  process.env.RAG_DOC_ACCESS_GROUPS = 'on';
  for (const method of ['warn', 'error', 'log', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  delete process.env.RAG_DOC_ACCESS_GROUPS;
  delete process.env.RAG_EMBED_ACCESS_GROUP;
});

type Loaded = Awaited<ReturnType<typeof load>>;
const put = (l: Loaded, body: unknown, org?: string) =>
  l.access.PUT(req(`/api/rag/access-groups/documents/access${org ? `?organizationId=${org}` : ''}`, { method: 'PUT', body }));
const listDocs = (l: Loaded, query = '') => l.documents.GET(req(`/api/rag/access-groups/documents${query}`));
const accessCalls = () => state.rpcCalls.filter((call) => /^rag_(set_document_access|access_document)/.test(call.fn));

describe('access document routes: list and relabel (D-17, UI-SPEC 6.4)', () => {
  it('an admin relabels one document to group-a and the restricted list shows it with that audience', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await put(loaded, { documentIds: [DOC_1], groupIds: [GROUP_A] });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ success: true, changed: 1, skipped: 0, notFound: 0 });
    expect(body.audiences).toEqual([
      expect.objectContaining({ documentId: DOC_1, kind: 'groups', groups: [{ id: GROUP_A, name: 'Group A' }], connectorManaged: false }),
    ]);
    expect(state.rpcCalls).toContainEqual({
      fn: 'rag_set_document_access_groups',
      args: { p_tenant_key: 's:default', p_document_ids: [DOC_1], p_keys: [`g:${GROUP_A}`], p_actor: ADMIN_ID, p_actor_kind: 'admin', p_reason: 'admin_set' },
    });

    const listed = await listDocs(loaded, '?filter=restricted');
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const page = await listed.json();
    expect(page.personal).toBe(false);
    expect(page.documents).toEqual([
      {
        documentId: DOC_1,
        filename: 'document-a.pdf',
        docType: 'general',
        source: 'upload',
        status: 'ready',
        createdAt: '2026-11-27T08:00:00.000Z',
        kind: 'groups',
        groups: [{ id: GROUP_A, name: 'Group A' }],
        peopleCount: 2,
        fallbackReason: null,
        connectorManaged: false,
      },
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.counts).toEqual({ restricted: 1, uploaderOnly: 1, everyone: 2, all: 4 });
  });

  it('passes filter, file-name search and cursor through and returns the counts under the same search', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const page = await (await listDocs(loaded, '?filter=everyone&q=document-b&cursor=Y3Vyc29y')).json();
    expect(page.documents.map((doc: { documentId: string }) => doc.documentId)).toEqual([DOC_2]);
    expect(page.counts).toEqual({ restricted: 0, uploaderOnly: 0, everyone: 1, all: 1 });
    expect(state.rpcCalls).toContainEqual({
      fn: 'rag_access_documents_list',
      args: { p_tenant_key: 's:default', p_filter: 'everyone', p_query: 'document-b', p_cursor: 'Y3Vyc29y', p_limit: 50 },
    });
    expect((await listDocs(loaded, '?filter=hidden')).status).toBe(400);
  });

  it('a bulk relabel over three documents with one connector-managed document changes two and skips one', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const body = await (await put(loaded, { documentIds: [DOC_1, DOC_2, DOC_CONNECTOR], groupIds: [GROUP_A] })).json();
    expect(body).toMatchObject({ success: true, changed: 2, skipped: 1, notFound: 0 });
    expect(body.audiences.map((item: { documentId: string }) => item.documentId).sort()).toEqual([DOC_1, DOC_2]);
    expect(docs.find((doc) => doc.id === DOC_CONNECTOR)?.keys).toEqual([]);
  });

  it('relabels back to everyone', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    await put(loaded, { documentIds: [DOC_1], groupIds: [GROUP_A] });
    const body = await (await put(loaded, { documentIds: [DOC_1], everyone: true })).json();
    expect(body.changed).toBe(1);
    expect(body.audiences[0]).toMatchObject({ kind: 'everyone', groups: [] });
    expect(state.rpcCalls.at(-2)?.args.p_keys).toEqual(['all']);
  });

  it('a single connector document answers 409 access_managed_by_connector and is not changed', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await put(loaded, { documentIds: [DOC_CONNECTOR], everyone: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'access_managed_by_connector' });
    expect(docs.find((doc) => doc.id === DOC_CONNECTOR)?.keys).toEqual([]);
  });

  it('a group that no longer exists answers 400 unknown_group; one unknown document answers 404', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const gone = await put(loaded, { documentIds: [DOC_1], groupIds: [GROUP_GONE] });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({ success: false, error: 'unknown_group' });
    const other = await put(loaded, { documentIds: [DOC_OTHER], everyone: true });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ success: false, error: 'not_found' });
    expect(docs.find((doc) => doc.id === DOC_OTHER)?.keys).toEqual(['all']);
  });

  it('refuses both everyone and groupIds, neither, principal keys, everyone false and oversized lists with 400 before any call', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const bodies: unknown[] = [
      { documentIds: [DOC_1], everyone: true, groupIds: [GROUP_A] },
      { documentIds: [DOC_1] },
      { documentIds: [DOC_1], groupIds: [`g:${GROUP_A}`] },
      { documentIds: [DOC_1], groupIds: ['all'] },
      { documentIds: [DOC_1], groupIds: [`u:${MEMBER_A}`] },
      { documentIds: [DOC_1], everyone: false },
      { documentIds: [], everyone: true },
      { documentIds: Array.from({ length: 501 }, () => DOC_1), everyone: true },
      { documentIds: [DOC_1], groupIds: Array.from({ length: 51 }, () => GROUP_A) },
      { documentIds: [DOC_1], everyone: true, keys: ['all'] },
      { documentIds: ['document-a.pdf'], everyone: true },
    ];
    for (const body of bodies) {
      const response = await put(loaded, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await response.json()).error).toBe('Invalid request data');
    }
    const raw = await loaded.access.PUT(req('/api/rag/access-groups/documents/access', { method: 'PUT', rawBody: '{not json' }));
    expect(raw.status).toBe(400);
    expect(accessCalls()).toEqual([]);
  });

  it('GET with ids returns only the audiences of those documents that are current in the workspace', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    const response = await listDocs(loaded, `?ids=${DOC_1},${DOC_CONNECTOR},${DOC_OTHER}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('documents');
    expect(body.audiences.map((item: { documentId: string }) => item.documentId).sort()).toEqual([DOC_1, DOC_CONNECTOR]);
    expect(body.audiences.find((item: { documentId: string }) => item.documentId === DOC_CONNECTOR)).toMatchObject({
      kind: 'uploader_only',
      connectorManaged: true,
      fallbackReason: 'unmapped_source_group',
      source: 'google-drive',
    });
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_access_documents_list')).toEqual([]);

    for (const bad of ['?ids=not-a-uuid', `?ids=${DOC_1}&filter=all`, `?ids=${Array.from({ length: 201 }, () => DOC_1).join(',')}`]) {
      expect((await listDocs(loaded, bad)).status).toBe(400);
    }
  });

  it('a member gets 403 Admin access required and no session 401; no access call is made', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    for (const response of [await put(loaded, { documentIds: [DOC_1], everyone: true }), await listDocs(loaded), await listDocs(loaded, `?ids=${DOC_1}`)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
    }
    state.session = null;
    expect((await put(loaded, { documentIds: [DOC_1], everyone: true })).status).toBe(401);
    expect((await listDocs(loaded)).status).toBe(401);
    expect(state.rpcCalls.filter((call) => call.fn.startsWith('rag_access_documents') || call.fn === 'rag_set_document_access_groups')).toEqual([]);
  });
});

describe('access document routes: organization admins (multi-tenant)', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.tables.organization_members = [
      { organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'admin' },
      { organization_id: ORG_O, user_id: MEMBER_A, role: 'member' },
    ];
  });

  it('an organization admin relabels and lists in their organization; a member of it is refused', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const response = await put(loaded, { organizationId: ORG_O, documentIds: [DOC_OTHER], groupIds: [GROUP_A] });
    expect(response.status).toBe(200);
    expect(state.rpcCalls.find((call) => call.fn === 'rag_set_document_access_groups')?.args).toMatchObject({ p_tenant_key: `o:${ORG_O}`, p_actor: ORG_ADMIN_ID });
    const page = await (await listDocs(loaded, `?organizationId=${ORG_O}&filter=restricted`)).json();
    expect(page.documents.map((doc: { documentId: string }) => doc.documentId)).toEqual([DOC_OTHER]);

    state.session = { id: MEMBER_A };
    const member = await put(loaded, { documentIds: [DOC_OTHER], everyone: true }, ORG_O);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ success: false, error: 'Admin access required' });
  });

  it('a body naming another workspace than the query is refused', async () => {
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    const mismatch = await put(loaded, { organizationId: '00000000-0000-4000-8000-0000000024c2', documentIds: [DOC_OTHER], everyone: true }, ORG_O);
    expect(mismatch.status).toBe(400);
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_set_document_access_groups')).toEqual([]);
  });
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const getStatus = (l: Loaded) => l.status.GET(req('/api/rag/access-groups/status'));
const runSync = (l: Loaded) => l.sync.POST(req('/api/rag/access-groups/status/sync', { method: 'POST' }));
const runDrift = (l: Loaded) => l.drift.POST(req('/api/rag/access-groups/drift', { method: 'POST' }));
const enforcementCalls = () => state.rpcCalls.filter((call) => /^rag_access_(enforced|set_enforced|readiness|groups_drift|group_by_key)$/.test(call.fn));

describe('access enforcement routes: status, sync and label check (A-03, A-08, D-03, D-07)', () => {
  it('GET status as an operator returns the switch, the database flag, readiness, the embed group and the check time', async () => {
    process.env.RAG_EMBED_ACCESS_GROUP = 'group-a';
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_access_enforced = { data: true, error: null };
    state.outcomes.rag_access_group_by_key = { data: [{ id: GROUP_A, key: 'group-a', name: 'Group A', source: 'manual', created_at: '2026-11-27T08:00:00.000Z' }], error: null };
    const response = await getStatus(loaded);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      status: {
        runningSwitch: 'on',
        databaseFlag: true,
        status: 'not_checked',
        ready: false,
        reasons: [],
        objects: [],
        embedGroup: { key: 'group-a', valid: true, exists: true, name: 'Group A' },
        checkedAt: null,
      },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(GROUP_A);
    expect(text).not.toContain('s:default');
    expect(state.rpcCalls.find((call) => call.fn === 'rag_access_group_by_key')?.args).toEqual({ p_tenant_key: 's:default', p_key: 'group-a' });
  });

  it('GET status reports a missing embed group as not found and no embed group when none is configured', async () => {
    process.env.RAG_EMBED_ACCESS_GROUP = 'group-z';
    let loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_access_group_by_key = { data: [], error: null };
    expect((await (await getStatus(loaded)).json()).status.embedGroup).toEqual({ key: 'group-z', valid: true, exists: false, name: null });

    delete process.env.RAG_EMBED_ACCESS_GROUP;
    loaded = await load();
    expect((await (await getStatus(loaded)).json()).status.embedGroup).toBeNull();
  });

  it('POST status/sync writes the flag, reruns the checks and returns the new verdict with its time', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    let flag = false;
    state.outcomes.rag_access_set_enforced = (args) => {
      flag = args.p_enforced === true;
      return { data: flag, error: null };
    };
    state.outcomes.rag_access_enforced = () => ({ data: flag, error: null });
    state.outcomes.rag_access_readiness = { data: [{ ready: true, reasons: [], objects: [] }], error: null };
    const response = await runSync(loaded);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(state.rpcCalls).toContainEqual({ fn: 'rag_access_set_enforced', args: { p_enforced: true } });
    expect(body.status.databaseFlag).toBe(true);
    expect(body.status.reasons).not.toContain('flag_write_failed');
    expect(body.status.checkedAt).toMatch(ISO_RE);
    expect(body.status.status).not.toBe('not_checked');
  });

  it('POST status/sync reports a failed flag write in the reasons and stays not ready', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_access_set_enforced = { data: null, error: { code: '42501', message: 'permission denied' } };
    state.outcomes.rag_access_enforced = { data: false, error: null };
    const body = await (await runSync(loaded)).json();
    expect(body.success).toBe(true);
    expect(body.status).toMatchObject({ runningSwitch: 'on', databaseFlag: false, status: 'not_ready', ready: false });
    expect(body.status.reasons).toContain('flag_write_failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('POST drift returns the differing rows per existing store and the time, with no repair action', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_access_groups_drift = {
      data: [
        { store: 'document_chunks', rows: 3 },
        { store: 'rag_parent_passages', rows: 0 },
      ],
      error: null,
    };
    const response = await runDrift(loaded);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['checkedAt', 'stores', 'success']);
    expect(body.stores).toEqual([
      { store: 'document_chunks', rows: 3 },
      { store: 'rag_parent_passages', rows: 0 },
    ]);
    expect(body.checkedAt).toMatch(ISO_RE);
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_access_groups_drift')).toEqual([{ fn: 'rag_access_groups_drift', args: {} }]);
  });

  it('POST drift answers 503 access_groups_unavailable when the check fails, without the database message', async () => {
    const loaded = await load();
    state.session = { id: ADMIN_ID };
    state.outcomes.rag_access_groups_drift = { data: null, error: { code: 'XX000', message: 'internal detail' } };
    const response = await runDrift(loaded);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'access_groups_unavailable' });
  });

  it('a member gets 403 Admin access required and no session 401, with no enforcement call', async () => {
    const loaded = await load();
    state.session = { id: MEMBER_A };
    for (const response of [await getStatus(loaded), await runSync(loaded), await runDrift(loaded)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
    }
    state.session = null;
    for (const response of [await getStatus(loaded), await runSync(loaded), await runDrift(loaded)]) expect(response.status).toBe(401);
    expect(enforcementCalls()).toEqual([]);
  });

  it('an organization admin without an admin session cannot read status, sync or run the label check (multi-tenant)', async () => {
    state.mode = 'multi-tenant';
    state.tables.organization_members = [{ organization_id: ORG_O, user_id: ORG_ADMIN_ID, role: 'owner' }];
    const loaded = await load();
    state.session = { id: ORG_ADMIN_ID };
    for (const response of [
      await getStatus(loaded),
      await runSync(loaded),
      await runDrift(loaded),
      await loaded.status.GET(req(`/api/rag/access-groups/status?organizationId=${ORG_O}`)),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Admin access required' });
    }
    expect(enforcementCalls()).toEqual([]);
  });
});
