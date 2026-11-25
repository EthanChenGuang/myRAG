import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const IMG_A = '00000000-0000-4000-8000-00000000d001';
const IMG_B = '00000000-0000-4000-8000-00000000d002';
const IMG_ORG_X = '00000000-0000-4000-8000-00000000d003';
const PDF_A = '00000000-0000-4000-8000-00000000d004';
const IMG_SINGLE = '00000000-0000-4000-8000-00000000d005';
const MISSING = '00000000-0000-4000-8000-00000000dfff';

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  authThrows: false,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  documents: [] as Row[],
  chunks: [] as Row[],
  deletes: [] as Array<{ table: string; filters: Filter[] }>,
  removed: [] as string[][],
  admins: [] as string[],
  readOnly: false,
};

// Rows written before the Phase 3 columns existed read as current and ready, as the migration defaults make them.
const COLUMN_DEFAULTS: Row = { is_current: true, status: 'ready' };

function matches(row: Row, filters: Filter[]): boolean {
  const read = (column: string) => row[column] ?? COLUMN_DEFAULTS[column];
  return filters.every(([op, column, value]) => (op === 'is' ? (read(column) ?? null) === value : read(column) === value));
}

function dataAdmin() {
  return {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          state.removed.push(paths);
          return { error: null };
        },
      }),
    },
    from(table: string) {
      const rows: Row[] =
        table === 'documents'
          ? state.documents
          : table === 'admin_users'
            ? state.admins.map((id) => ({ id }))
            : table === 'admin_settings'
              ? [{ read_only_doc_dashboard: state.readOnly }]
              : state.chunks;
      const filters: Filter[] = [];
      let op: 'select' | 'delete' = 'select';
      let limit = Infinity;
      const run = () => {
        if (op === 'delete') {
          state.deletes.push({ table, filters: [...filters] });
          const keep = rows.filter((row) => !matches(row, filters));
          rows.splice(0, rows.length, ...keep);
          return { data: null, error: null };
        }
        return { data: rows.filter((row) => matches(row, filters)).slice(0, limit), error: null };
      };
      const builder = {
        select: () => builder,
        delete() {
          op = 'delete';
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
        order: () => builder,
        abortSignal: () => builder,
        limit(n: number) {
          limit = n;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: rows.find((row) => matches(row, filters)) ?? null, error: null }),
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
  return import('@/app/api/images/route');
}

function req(method: 'GET' | 'DELETE', query = '') {
  return new NextRequest(`http://localhost/api/images${query}`, { method });
}

const ids = (rows: Row[]) => rows.map((row) => row.id);
const url = (name: string) => `https://example.supabase.co/storage/v1/object/public/chat-images/${name}`;

describe('images route', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = null;
    state.authThrows = false;
    state.admins = [];
    state.readOnly = false;
    state.members = [];
    state.documents = [
      { id: IMG_A, user_id: USER_A, organization_id: null, filename: 'a.png', created_at: '2026-01-03' },
      { id: IMG_B, user_id: USER_B, organization_id: null, filename: 'b.jpg', created_at: '2026-01-02' },
      { id: IMG_ORG_X, user_id: USER_B, organization_id: ORG_X, filename: 'x.webp', created_at: '2026-01-01' },
      { id: PDF_A, user_id: USER_A, organization_id: null, filename: 'report.pdf', created_at: '2026-01-04' },
    ];
    state.chunks = [
      { id: 'chunk-a', document_id: IMG_A, metadata: { image_url: url('a.png') } },
      { id: 'chunk-b', document_id: IMG_B, metadata: { image_url: url('b.jpg') } },
      { id: 'chunk-x', document_id: IMG_ORG_X, metadata: { image_url: url('x.webp') } },
      { id: 'chunk-pdf', document_id: PDF_A, metadata: {} },
    ];
    state.deletes = [];
    state.removed = [];
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
    const response = await DELETE(req('DELETE', `?id=${IMG_A}`));
    expect(response.status).toBe(401);
    expect(state.deletes).toEqual([]);
    expect(state.removed).toEqual([]);
    expect(ids(state.documents)).toContain(IMG_A);
  });

  it('answers 503 when the session lookup throws and deletes nothing', async () => {
    state.authThrows = true;
    const { DELETE } = await loadRoute();
    const response = await DELETE(req('DELETE', `?id=${IMG_A}`));
    expect(response.status).toBe(503);
    expect(state.deletes).toEqual([]);
  });

  it('answers 404 when user A deletes user B image, and deletes nothing', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    const foreign = await DELETE(req('DELETE', `?id=${IMG_B}`));
    const missing = await DELETE(req('DELETE', `?id=${MISSING}`));
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(state.deletes).toEqual([]);
    expect(state.removed).toEqual([]);
    expect(ids(state.documents)).toContain(IMG_B);
    expect(ids(state.chunks)).toContain('chunk-b');
  });

  it('answers 404 for a non-image document id even when the caller owns it', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    const response = await DELETE(req('DELETE', `?id=${PDF_A}`));
    expect(response.status).toBe(404);
    expect(state.deletes).toEqual([]);
    expect(ids(state.documents)).toContain(PDF_A);
    expect(ids(state.chunks)).toContain('chunk-pdf');
  });

  it('lets the owner delete an image, its chunks and its storage object', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    const response = await DELETE(req('DELETE', `?id=${IMG_A}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(ids(state.documents)).not.toContain(IMG_A);
    expect(ids(state.chunks)).not.toContain('chunk-a');
    expect(ids(state.documents)).toEqual([IMG_B, IMG_ORG_X, PDF_A]);
    expect(state.removed).toEqual([['a.png']]);
    const documentDelete = state.deletes.find((entry) => entry.table === 'documents');
    expect(documentDelete?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', IMG_A],
        ['is', 'organization_id', null],
        ['eq', 'user_id', USER_A],
      ]),
    );
  });

  it('removes the stored original and parse files of the image from the private bucket (W2)', async () => {
    state.session = { id: USER_A };
    const tenant = `u:${USER_A}`;
    const lineage = '00000000-0000-4000-8000-00000000e101';
    const own = (name: string) => `${tenant}/${lineage}/1/${name}`;
    const foreign = `u:${USER_B}/00000000-0000-4000-8000-00000000e102/1/original.png`;
    Object.assign(state.documents[0] as Row, {
      tenant_key: tenant,
      lineage_id: lineage,
      version: 1,
      original_path: own('original.png'),
      processing_state: { artifacts: { 'parse.md': own('parse.md'), 'tampered.png': foreign } },
    });
    const route = await loadRoute();
    const { installFakeObjectStore } = await import('../helpers/fake-object-store');
    const store = installFakeObjectStore();
    for (const key of [own('original.png'), own('parse.md'), foreign]) {
      await store.put(key, new Uint8Array([1]), { contentType: 'application/octet-stream' });
    }
    const response = await route.DELETE(req('DELETE', `?id=${IMG_A}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(store.keys()).toEqual([foreign]);
  });

  it('lets an org member delete an org image', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(req('DELETE', `?id=${IMG_ORG_X}&organization_id=${ORG_X}`));
    expect(response.status).toBe(200);
    expect(ids(state.documents)).not.toContain(IMG_ORG_X);
    expect(ids(state.chunks)).not.toContain('chunk-x');
    expect(ids(state.documents)).toContain(IMG_B);
  });

  it('refuses a non-member DELETE with 403 and deletes nothing', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const { DELETE } = await loadRoute();
    const response = await DELETE(req('DELETE', `?id=${IMG_ORG_X}&organization_id=${ORG_X}`));
    expect(response.status).toBe(403);
    expect(state.deletes).toEqual([]);
    expect(ids(state.documents)).toContain(IMG_ORG_X);
  });

  it('rejects a missing or malformed id before touching data', async () => {
    state.session = { id: USER_A };
    const { DELETE } = await loadRoute();
    expect((await DELETE(req('DELETE'))).status).toBe(400);
    expect((await DELETE(req('DELETE', '?id=not-a-uuid'))).status).toBe(400);
    expect(state.deletes).toEqual([]);
  });

  it('refuses GET with no session', async () => {
    const { GET } = await loadRoute();
    expect((await GET(req('GET'))).status).toBe(401);
  });

  it('refuses GET for an organization the caller is not a member of', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const { GET } = await loadRoute();
    const response = await GET(req('GET', `?organization_id=${ORG_X}`));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('x.webp');
  });

  it('lists only the caller personal images and skips non-images', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoute();
    const response = await GET(req('GET'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { images: Array<{ id: string; url: string }> };
    expect(body.images.map((image) => image.id)).toEqual([IMG_A]);
    expect(body.images[0].url).toBe(url('a.png'));
  });

  it('lists the org images for a member', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { GET } = await loadRoute();
    const response = await GET(req('GET', `?organization_id=${ORG_X}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { images: Array<{ id: string }> };
    expect(body.images.map((image) => image.id)).toEqual([IMG_ORG_X]);
  });

  it('single-tenant: a signed-in non-owner non-admin lists but cannot delete another user image (404)', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    state.documents = [{ id: IMG_SINGLE, user_id: USER_B, organization_id: null, filename: 's.png', created_at: '2026-01-01' }];
    state.chunks = [{ id: 'chunk-s', document_id: IMG_SINGLE, metadata: { image_url: url('s.png') } }];
    const { GET, DELETE } = await loadRoute();
    const listed = (await (await GET(req('GET'))).json()) as { images: Array<{ id: string }> };
    expect(listed.images.map((image) => image.id)).toEqual([IMG_SINGLE]);
    expect((await DELETE(req('DELETE', `?id=${IMG_SINGLE}`))).status).toBe(404);
    expect(state.deletes).toEqual([]);
    expect(state.documents).toHaveLength(1);
    expect(state.removed).toEqual([]);
  });

  it('single-tenant: an admin can delete another user image', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    state.admins = [USER_A];
    state.documents = [{ id: IMG_SINGLE, user_id: USER_B, organization_id: null, filename: 's.png', created_at: '2026-01-01' }];
    state.chunks = [{ id: 'chunk-s', document_id: IMG_SINGLE, metadata: { image_url: url('s.png') } }];
    const { DELETE } = await loadRoute();
    expect((await DELETE(req('DELETE', `?id=${IMG_SINGLE}`))).status).toBe(200);
    expect(state.documents).toEqual([]);
  });

  it('single-tenant read_only_doc_dashboard: a non-admin owner gets 403 on DELETE, listing still works', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    state.readOnly = true;
    state.documents = [{ id: IMG_SINGLE, user_id: USER_A, organization_id: null, filename: 's.png', created_at: '2026-01-01' }];
    state.chunks = [{ id: 'chunk-s', document_id: IMG_SINGLE, metadata: { image_url: url('s.png') } }];
    const { GET, DELETE } = await loadRoute();
    expect((await GET(req('GET'))).status).toBe(200);
    expect((await DELETE(req('DELETE', `?id=${IMG_SINGLE}`))).status).toBe(403);
    expect(state.deletes).toEqual([]);
  });

  it('single-tenant: the owner lists and deletes their own image', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    state.documents = [{ id: IMG_SINGLE, user_id: USER_A, organization_id: null, filename: 's.png', created_at: '2026-01-01' }];
    state.chunks = [{ id: 'chunk-s', document_id: IMG_SINGLE, metadata: { image_url: url('s.png') } }];
    const { GET, DELETE } = await loadRoute();
    const listed = (await (await GET(req('GET'))).json()) as { images: Array<{ id: string }> };
    expect(listed.images.map((image) => image.id)).toEqual([IMG_SINGLE]);
    const response = await DELETE(req('DELETE', `?id=${IMG_SINGLE}`));
    expect(response.status).toBe(200);
    expect(state.documents).toEqual([]);
    expect(state.chunks).toEqual([]);
  });

  it('single-tenant: anonymous GET and DELETE get 401 and delete nothing', async () => {
    state.mode = 'single-tenant';
    state.documents = [{ id: IMG_SINGLE, organization_id: null, filename: 's.png', created_at: '2026-01-01' }];
    state.chunks = [{ id: 'chunk-s', document_id: IMG_SINGLE, metadata: { image_url: url('s.png') } }];
    const { GET, DELETE } = await loadRoute();
    expect((await GET(req('GET'))).status).toBe(401);
    expect((await DELETE(req('DELETE', `?id=${IMG_SINGLE}`))).status).toBe(401);
    expect(state.deletes).toEqual([]);
    expect(state.documents).toHaveLength(1);
  });

  it('keeps logs free of image urls and filenames', async () => {
    state.session = { id: USER_A };
    const logs = vi.spyOn(console, 'log');
    const errors = vi.spyOn(console, 'error');
    const { GET, DELETE } = await loadRoute();
    await GET(req('GET'));
    await DELETE(req('DELETE', `?id=${IMG_A}`));
    const text = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
    expect(text).not.toContain('a.png');
    expect(text).not.toContain('chat-images');
  });
});
