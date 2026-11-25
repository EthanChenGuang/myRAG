import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const ORG_Y = '00000000-0000-4000-8000-0000000000c2';
const DOC_A_PERSONAL = '00000000-0000-4000-8000-00000000d001';
const DOC_B_PERSONAL = '00000000-0000-4000-8000-00000000d002';
const DOC_ORG_X = '00000000-0000-4000-8000-00000000d003';
const DOC_ORG_Y = '00000000-0000-4000-8000-00000000d004';
const DOC_SINGLE = '00000000-0000-4000-8000-00000000d005';
const MISSING_DOC = '00000000-0000-4000-8000-00000000dfff';

type Row = Record<string, unknown>;

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  authThrows: false,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  documents: [] as Row[],
  chunks: [] as Row[],
  deletes: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  updates: [] as Array<{ table: string; payload: Row; filters: Array<[string, string, unknown]> }>,
  admins: [] as string[],
  readOnly: false,
  settingsFail: false,
};

// The columns the Phase 3 migrations add: lineage_id defaults to the row id, tenant_key is generated from the owner columns.
function read(row: Row, column: string): unknown {
  if (column === 'lineage_id') return row.lineage_id ?? row.id;
  if (column === 'is_current') return row.is_current ?? true;
  if (column === 'tenant_key') {
    if (state.mode === 'single-tenant') return 's:default';
    return row.organization_id ? `o:${row.organization_id}` : `u:${row.user_id}`;
  }
  return row[column];
}

function matches(row: Row, filters: Array<[string, string, unknown]>): boolean {
  return filters.every(([op, column, value]) => {
    if (op === 'is') return (read(row, column) ?? null) === value;
    if (op === 'in') return (value as unknown[]).includes(read(row, column));
    return read(row, column) === value;
  });
}

function dataAdmin() {
  return {
    from(table: string) {
      const rows: Row[] =
        table === 'documents'
          ? state.documents
          : table === 'admin_users'
            ? state.admins.map((id) => ({ id }))
            : table === 'admin_settings'
              ? [{ read_only_doc_dashboard: state.readOnly }]
              : state.chunks;
      const filters: Array<[string, string, unknown]> = [];
      let op: 'select' | 'delete' | 'update' = 'select';
      let payload: Row = {};
      const run = () => {
        if (op === 'delete') {
          state.deletes.push({ table, filters: [...filters] });
          const keep = rows.filter((row) => !matches(row, filters));
          rows.splice(0, rows.length, ...keep);
        } else if (op === 'update') {
          state.updates.push({ table, payload, filters: [...filters] });
          rows.filter((row) => matches(row, filters)).forEach((row) => Object.assign(row, payload));
        } else {
          return { data: rows.filter((row) => matches(row, filters)), error: null };
        }
        return { data: null, error: null };
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        delete() {
          op = 'delete';
          return builder;
        },
        update(next: Row) {
          op = 'update';
          payload = next;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push(['eq', column, value]);
          return builder;
        },
        is(column: string, value: unknown) {
          filters.push(['is', column, value]);
          return builder;
        },
        in(column: string, value: unknown[]) {
          filters.push(['in', column, value]);
          return builder;
        },
        maybeSingle: () =>
          table === 'admin_settings' && state.settingsFail
            ? Promise.resolve({ data: null, error: { code: 'XX000', message: 'down' } })
            : Promise.resolve({ data: rows.find((row) => matches(row, filters)) ?? null, error: null }),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

function membershipAdmin() {
  return {
    from() {
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq(column: string, value: string) {
          filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          const row = state.members.find(
            (member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id,
          );
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

async function loadRoute() {
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
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/auth/organization-handler', () => ({ verifyUserOrganizationAccess: async () => ({ hasAccess: false }) }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => dataAdmin(), supabaseAdmin: dataAdmin() }));
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => membershipAdmin() as never });
  return import('@/app/api/documents/[id]/route');
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function call(method: 'DELETE' | 'PATCH', id: string, query = '', body?: Record<string, unknown>) {
  const request = new NextRequest(`http://localhost/api/documents/${id}${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return [request, ctx(id)] as const;
}

const ids = (rows: Row[]) => rows.map((row) => row.id);

describe('documents/[id] route', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = null;
    state.authThrows = false;
    state.members = [];
    state.documents = [
      { id: DOC_A_PERSONAL, user_id: USER_A, organization_id: null, metadata: { keep: 'yes' } },
      { id: DOC_B_PERSONAL, user_id: USER_B, organization_id: null, metadata: {} },
      { id: DOC_ORG_X, user_id: USER_B, organization_id: ORG_X, metadata: {} },
      { id: DOC_ORG_Y, user_id: USER_B, organization_id: ORG_Y, metadata: {} },
    ];
    state.chunks = [
      { id: 'chunk-a', document_id: DOC_A_PERSONAL },
      { id: 'chunk-b', document_id: DOC_B_PERSONAL },
      { id: 'chunk-x', document_id: DOC_ORG_X },
      { id: 'chunk-y', document_id: DOC_ORG_Y },
    ];
    state.deletes = [];
    state.updates = [];
    state.admins = [];
    state.readOnly = false;
    state.settingsFail = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/deployment-mode');
    vi.doUnmock('@/lib/auth/organization-handler');
  });

  it('refuses DELETE with no session and deletes nothing', async () => {
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_A_PERSONAL));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(state.deletes).toEqual([]);
    expect(ids(state.documents)).toContain(DOC_A_PERSONAL);
  });

  it('refuses PATCH with no session and updates nothing', async () => {
    const { PATCH } = await loadRoute();
    const response = await PATCH(...call('PATCH', DOC_A_PERSONAL, '', { external_url: 'https://example.com/doc' }));
    expect(response.status).toBe(401);
    expect(state.updates).toEqual([]);
  });

  it('answers 503 when the session lookup throws and deletes nothing', async () => {
    state.authThrows = true;
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_A_PERSONAL));
    expect(response.status).toBe(503);
    expect(state.deletes).toEqual([]);
  });

  it('answers 404 when user A deletes tenant B personal document, and deletes nothing', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_B_PERSONAL));
    expect(response.status).toBe(404);
    expect(state.deletes).toEqual([]);
    expect(ids(state.documents)).toContain(DOC_B_PERSONAL);
    expect(ids(state.chunks)).toContain('chunk-b');
  });

  it('answers 404 for another tenant id exactly as for a nonexistent id', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    const foreign = await DELETE(...call('DELETE', DOC_B_PERSONAL));
    const missing = await DELETE(...call('DELETE', MISSING_DOC));
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it('answers 404 when user A names its own org but the document sits in a different one', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_ORG_Y, `?organizationId=${ORG_X}`));
    expect(response.status).toBe(404);
    expect(state.deletes).toEqual([]);
  });

  it('answers 404 when an org member targets a personal document of another user', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_B_PERSONAL, `?organizationId=${ORG_X}`));
    expect(response.status).toBe(404);
    expect(state.deletes).toEqual([]);
  });

  it('answers 404 when PATCH targets another tenant document, and updates nothing', async () => {
    state.session = { id: USER_A };
    const { PATCH } = await loadRoute();
    const response = await PATCH(...call('PATCH', DOC_B_PERSONAL, '', { external_url: 'https://example.com/doc' }));
    expect(response.status).toBe(404);
    expect(state.updates).toEqual([]);
    expect(state.documents.find((row) => row.id === DOC_B_PERSONAL)?.metadata).toEqual({});
  });

  it('lets the owner delete a personal document and its chunks', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_A_PERSONAL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(ids(state.documents)).not.toContain(DOC_A_PERSONAL);
    expect(ids(state.chunks)).not.toContain('chunk-a');
    expect(ids(state.documents)).toEqual([DOC_B_PERSONAL, DOC_ORG_X, DOC_ORG_Y]);
    expect(ids(state.chunks)).toEqual(['chunk-b', 'chunk-x', 'chunk-y']);
  });

  it('lets the owner PATCH the external url and keeps existing metadata', async () => {
    state.session = { id: USER_A };
    const { PATCH } = await loadRoute();
    const response = await PATCH(...call('PATCH', DOC_A_PERSONAL, '', { external_url: 'https://example.com/doc' }));
    expect(response.status).toBe(200);
    expect(state.documents.find((row) => row.id === DOC_A_PERSONAL)?.metadata).toEqual({
      keep: 'yes',
      external_url: 'https://example.com/doc',
    });
  });

  it('lets an org member delete an org document', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_ORG_X, `?organizationId=${ORG_X}`));
    expect(response.status).toBe(200);
    expect(ids(state.documents)).not.toContain(DOC_ORG_X);
    expect(ids(state.chunks)).not.toContain('chunk-x');
    expect(ids(state.documents)).toContain(DOC_ORG_Y);
  });

  it('takes the organization for PATCH from the JSON body when the query has none', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { PATCH } = await loadRoute();
    const response = await PATCH(
      ...call('PATCH', DOC_ORG_X, '', { external_url: 'https://example.com/doc', organizationId: ORG_X }),
    );
    expect(response.status).toBe(200);
    expect((state.documents.find((row) => row.id === DOC_ORG_X)?.metadata as Row).external_url).toBe('https://example.com/doc');
  });

  it('refuses a non-member with 403 and deletes nothing', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_ORG_X, `?organizationId=${ORG_X}`));
    expect(response.status).toBe(403);
    expect(state.deletes).toEqual([]);
    expect(ids(state.documents)).toContain(DOC_ORG_X);
  });

  it('refuses a non-member PATCH with 403', async () => {
    state.session = { id: USER_A };
    const { PATCH } = await loadRoute();
    const response = await PATCH(...call('PATCH', DOC_ORG_X, `?organizationId=${ORG_X}`, { external_url: 'https://example.com/doc' }));
    expect(response.status).toBe(403);
    expect(state.updates).toEqual([]);
  });

  it('lets the owner delete their own document in single-tenant mode', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    state.documents = [{ id: DOC_SINGLE, user_id: USER_A, organization_id: null, metadata: {} }];
    state.chunks = [{ id: 'chunk-s', document_id: DOC_SINGLE }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_SINGLE));
    expect(response.status).toBe(200);
    expect(state.documents).toEqual([]);
    expect(state.chunks).toEqual([]);
  });

  describe('single-tenant: any account can sign up, so a session is not enough to change the knowledge base', () => {
    beforeEach(() => {
      state.mode = 'single-tenant';
      state.documents = [
        { id: DOC_SINGLE, user_id: USER_B, organization_id: null, metadata: { keep: 'yes' } },
        { id: DOC_A_PERSONAL, user_id: null, organization_id: null, metadata: {} },
      ];
      state.chunks = [
        { id: 'chunk-s', document_id: DOC_SINGLE },
        { id: 'chunk-legacy', document_id: DOC_A_PERSONAL },
      ];
    });

    it('a signed-in non-owner non-admin gets 404 on DELETE and PATCH of another user document and nothing changes', async () => {
      state.session = { id: USER_A };
      const { DELETE, PATCH } = await loadRoute();
      expect((await DELETE(...call('DELETE', DOC_SINGLE))).status).toBe(404);
      expect((await PATCH(...call('PATCH', DOC_SINGLE, '', { external_url: 'https://example.com/doc' }))).status).toBe(404);
      expect(state.deletes).toEqual([]);
      expect(state.updates).toEqual([]);
      expect(ids(state.documents)).toEqual([DOC_SINGLE, DOC_A_PERSONAL]);
      expect(state.chunks).toHaveLength(2);
    });

    it('a legacy document without an owner is admin-only: 404 for a regular user', async () => {
      state.session = { id: USER_A };
      const { DELETE } = await loadRoute();
      expect((await DELETE(...call('DELETE', DOC_A_PERSONAL))).status).toBe(404);
      expect(ids(state.documents)).toContain(DOC_A_PERSONAL);
    });

    it('an admin can delete and patch documents they do not own', async () => {
      state.session = { id: USER_A };
      state.admins = [USER_A];
      const { DELETE, PATCH } = await loadRoute();
      expect((await PATCH(...call('PATCH', DOC_SINGLE, '', { external_url: 'https://example.com/doc' }))).status).toBe(200);
      expect((await DELETE(...call('DELETE', DOC_SINGLE))).status).toBe(200);
      expect((await DELETE(...call('DELETE', DOC_A_PERSONAL))).status).toBe(200);
      expect(state.documents).toEqual([]);
    });

    it('read_only_doc_dashboard: a non-admin owner gets 403 on DELETE and PATCH, an admin still can', async () => {
      state.readOnly = true;
      state.documents = [{ id: DOC_SINGLE, user_id: USER_A, organization_id: null, metadata: {} }];
      state.session = { id: USER_A };
      const { DELETE, PATCH } = await loadRoute();
      expect((await DELETE(...call('DELETE', DOC_SINGLE))).status).toBe(403);
      expect((await PATCH(...call('PATCH', DOC_SINGLE, '', { external_url: 'https://example.com/doc' }))).status).toBe(403);
      expect(state.deletes).toEqual([]);
      expect(state.updates).toEqual([]);
      state.admins = [USER_A];
      expect((await DELETE(...call('DELETE', DOC_SINGLE))).status).toBe(200);
    });

    it('fails closed with 503 when the settings lookup fails', async () => {
      state.session = { id: USER_A };
      state.settingsFail = true;
      state.documents = [{ id: DOC_SINGLE, user_id: USER_A, organization_id: null, metadata: {} }];
      const { DELETE } = await loadRoute();
      expect((await DELETE(...call('DELETE', DOC_SINGLE))).status).toBe(503);
      expect(state.deletes).toEqual([]);
    });
  });

  it('refuses an anonymous delete in single-tenant mode', async () => {
    state.mode = 'single-tenant';
    state.documents = [{ id: DOC_SINGLE, organization_id: null, metadata: {} }];
    state.chunks = [{ id: 'chunk-s', document_id: DOC_SINGLE }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(...call('DELETE', DOC_SINGLE));
    expect(response.status).toBe(401);
    expect(state.deletes).toEqual([]);
    expect(state.documents).toHaveLength(1);
  });

  it('refuses an anonymous PATCH in single-tenant mode', async () => {
    state.mode = 'single-tenant';
    state.documents = [{ id: DOC_SINGLE, organization_id: null, metadata: {} }];
    const { PATCH } = await loadRoute();
    const response = await PATCH(...call('PATCH', DOC_SINGLE, '', { external_url: 'https://example.com/doc' }));
    expect(response.status).toBe(401);
    expect(state.updates).toEqual([]);
  });

  it('rejects a malformed id and an unsafe external url before touching data', async () => {
    state.session = { id: USER_A };
    const { DELETE, PATCH } = await loadRoute();
    expect((await DELETE(...call('DELETE', 'not-a-uuid'))).status).toBe(400);
    expect((await PATCH(...call('PATCH', DOC_A_PERSONAL, '', { external_url: 'javascript:alert(1)' }))).status).toBe(400);
    expect((await PATCH(...call('PATCH', DOC_A_PERSONAL, '', {}))).status).toBe(400);
    expect(state.deletes).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('keeps logs free of document content', async () => {
    state.session = { id: USER_A };
    const logs = vi.spyOn(console, 'log');
    const errors = vi.spyOn(console, 'error');
    const { DELETE } = await loadRoute();
    await DELETE(...call('DELETE', DOC_A_PERSONAL));
    expect(JSON.stringify([...logs.mock.calls, ...errors.mock.calls])).not.toContain('keep');
  });
});

describe('documents/[id] DELETE removes the stored originals (W2)', () => {
  const LINEAGE = '00000000-0000-4000-8000-00000000e001';
  const V1 = '00000000-0000-4000-8000-00000000e011';
  const V2 = '00000000-0000-4000-8000-00000000e012';
  const FOREIGN_LINEAGE = '00000000-0000-4000-8000-00000000e002';
  const TENANT_A = `u:${USER_A}`;
  const TENANT_B = `u:${USER_B}`;
  const keyOf = (tenant: string, lineage: string, version: number, name: string) => `${tenant}/${lineage}/${version}/${name}`;

  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_A };
    state.authThrows = false;
    state.members = [];
    state.documents = [
      {
        id: V1,
        lineage_id: LINEAGE,
        version: 1,
        user_id: USER_A,
        organization_id: null,
        original_path: keyOf(TENANT_A, LINEAGE, 1, 'original.pdf'),
        processing_state: { artifacts: { 'parse.md': keyOf(TENANT_A, LINEAGE, 1, 'parse.md'), 'docling.json': keyOf(TENANT_A, LINEAGE, 1, 'docling.json') } },
      },
      {
        id: V2,
        lineage_id: LINEAGE,
        version: 2,
        user_id: USER_A,
        organization_id: null,
        original_path: keyOf(TENANT_B, FOREIGN_LINEAGE, 1, 'original.pdf'),
        processing_state: { artifacts: { 'parse.md': keyOf(TENANT_A, LINEAGE, 2, 'parse.md') } },
      },
      { id: DOC_B_PERSONAL, lineage_id: FOREIGN_LINEAGE, version: 1, user_id: USER_B, organization_id: null, original_path: keyOf(TENANT_B, FOREIGN_LINEAGE, 1, 'original.pdf') },
    ];
    state.chunks = [];
    state.deletes = [];
    state.updates = [];
    state.admins = [];
    state.readOnly = false;
    state.settingsFail = false;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/deployment-mode');
    vi.doUnmock('@/lib/auth/organization-handler');
  });

  async function seededStore() {
    const route = await loadRoute();
    const { installFakeObjectStore } = await import('../helpers/fake-object-store');
    const store = installFakeObjectStore();
    const bytes = new Uint8Array([1]);
    for (const key of [
      keyOf(TENANT_A, LINEAGE, 1, 'original.pdf'),
      keyOf(TENANT_A, LINEAGE, 1, 'parse.md'),
      keyOf(TENANT_A, LINEAGE, 1, 'docling.json'),
      keyOf(TENANT_A, LINEAGE, 2, 'parse.md'),
      keyOf(TENANT_B, FOREIGN_LINEAGE, 1, 'original.pdf'),
    ]) {
      await store.put(key, bytes, { contentType: 'application/octet-stream' });
    }
    store.calls.length = 0;
    return { route, store };
  }

  it('removes the original and parse files of every version, and never a path of another tenant', async () => {
    const { route, store } = await seededStore();
    const response = await route.DELETE(...call('DELETE', V1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(ids(state.documents)).toEqual([DOC_B_PERSONAL]);
    expect(store.keys()).toEqual([keyOf(TENANT_B, FOREIGN_LINEAGE, 1, 'original.pdf')]);
    expect(store.calls.every((entry) => entry.op === 'remove' && entry.key.startsWith(`${TENANT_A}/${LINEAGE}/`))).toBe(true);
  });

  it('still deletes the rows and reports artifacts_failed when the storage removal fails', async () => {
    const { route, store } = await seededStore();
    store.failOn('remove');
    const response = await route.DELETE(...call('DELETE', V1));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, artifacts_failed: 4 });
    expect(ids(state.documents)).toEqual([DOC_B_PERSONAL]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(TENANT_A);
  });

  it('touches no stored object when the document belongs to another tenant', async () => {
    const { route, store } = await seededStore();
    const response = await route.DELETE(...call('DELETE', DOC_B_PERSONAL));
    expect(response.status).toBe(404);
    expect(store.calls).toEqual([]);
    expect(store.keys()).toHaveLength(5);
  });
});
