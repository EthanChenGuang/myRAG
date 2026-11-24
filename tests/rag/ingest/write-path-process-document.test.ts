import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestInput, IngestResult } from '@/lib/rag/ingest';
import { mintAdminSessionValue } from '@/lib/admin-session';

const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const ORG_Y = '00000000-0000-4000-8000-0000000000c2';
const DOCUMENT = '00000000-0000-4000-8000-0000000000e1';
const DUPLICATE_OF = '00000000-0000-4000-8000-0000000000d1';
const SERVICE_KEY = 'test-service-role-key-placeholder';
const BODY = 'First placeholder paragraph.\n\nSecond placeholder paragraph.';

type Row = Record<string, unknown>;
type Mode = 'single-tenant' | 'multi-tenant';

const state = {
  mode: 'single-tenant' as Mode,
  session: null as { id: string } | null,
  authThrows: false,
  sessionLookups: 0,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  admins: [] as string[],
  readOnly: false,
  inserts: [] as Array<{ table: string; rows: Row[] }>,
  llamaCalls: 0,
  embedCalls: 0,
  checkAdminCalls: 0,
  adminGuardQueries: 0,
  adminGuardFails: false,
};

function routeAdmin() {
  return {
    from(table: string) {
      let filter: unknown;
      const builder = {
        eq(_column: string, value: unknown) {
          filter = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => {
          if (table === 'admin_users') return Promise.resolve({ data: state.admins.includes(filter as string) ? { id: filter } : null, error: null });
          if (table === 'admin_settings') return Promise.resolve({ data: { read_only_doc_dashboard: state.readOnly }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        insert(rows: Row[]) {
          state.inserts.push({ table, rows });
          return builder;
        },
        select: () => builder,
        single: () => Promise.resolve({ data: { id: 'doc' }, error: null }),
        then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok, bad),
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: {}, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'http://127.0.0.1/placeholder' } }),
      }),
    },
  };
}

/** The admin client of the admin guard (checkAdmin): counts every admin_users lookup so a test can show it never ran. */
function guardAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from() {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          state.adminGuardQueries += 1;
          if (state.adminGuardFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          const hit = state.admins.includes(filters.id as string);
          return Promise.resolve({ data: hit ? { id: filters.id } : null, error: null });
        },
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
          const row = state.members.find((member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id);
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

const ingestSpy = vi.fn<(input: IngestInput) => Promise<IngestResult>>();

const readyResult: IngestResult = {
  status: 'ready',
  documentId: DOCUMENT,
  version: 1,
  parserUsed: 'text',
  chunkCount: 3,
  warnings: [],
};

async function loadPost(pipeline: string | undefined): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', pipeline ?? '');
  vi.doMock('@/lib/deployment-mode', () => ({
    getDeploymentMode: () => state.mode,
    isMultiTenant: () => state.mode === 'multi-tenant',
    isSingleTenant: () => state.mode === 'single-tenant',
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          state.sessionLookups += 1;
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => guardAdmin(), getSupabase: () => ({}) }));
  vi.doMock('@/lib/auth/organization-handler', () => ({
    verifyUserOrganizationAccess: async (userId: string, organizationId: string) => ({
      hasAccess: state.members.some((member) => member.user_id === userId && member.organization_id === organizationId),
    }),
  }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => routeAdmin() }));
  vi.doMock('node-fetch', () => ({
    default: async (url: string) => {
      state.llamaCalls += 1;
      const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' });
      if (url.endsWith('/parsing/upload')) return json({ id: 'job-1', status: 'PENDING' });
      if (url.endsWith('/result/markdown')) return json({ markdown: 'Placeholder document body text.', metadata: { total_pages: 1 }, chunks: ['Placeholder document body text.'] });
      return json({ status: 'SUCCESS' });
    },
  }));
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/admin-route-auth')>();
    return {
      ...original,
      checkAdmin: (request: Request) => {
        state.checkAdminCalls += 1;
        return original.checkAdmin(request);
      },
    };
  });
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...original,
      embedText: async () => {
        state.embedCalls += 1;
        return [0.1, 0.2];
      },
      ingest: (input: IngestInput) => ingestSpy(input),
    };
  });
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => membershipAdmin() as never });
  const { POST } = await import('@/app/api/process-document/route');
  return POST;
}

interface UploadOptions {
  name?: string;
  type?: string;
  bytes?: Uint8Array | string;
  temporary?: boolean;
  cookie?: string;
  headers?: Record<string, string>;
}

function upload(fields: Record<string, string> = {}, options: UploadOptions = {}): Request {
  const form = new FormData();
  form.append('file', new File([(options.bytes ?? BODY) as BlobPart], options.name ?? 'notes.txt', { type: options.type ?? 'text/plain' }));
  form.append('isTemporary', String(options.temporary ?? false));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request('http://localhost/api/process-document', {
    method: 'POST',
    body: form,
    headers: { ...(options.cookie ? { cookie: `admin_session=${options.cookie}` } : {}), ...options.headers },
  });
}

const adminCookie = (userId: string): string => mintAdminSessionValue(userId, { serviceKey: SERVICE_KEY }) as string;

async function keyOf(scope: IngestInput['scope']): Promise<string> {
  const { scopeKey } = await import('@/lib/rag/tenant/scope');
  return scopeKey(scope);
}

function lastIngest(): IngestInput {
  expect(ingestSpy, 'ingest was called').toHaveBeenCalled();
  return ingestSpy.mock.calls.at(-1)?.[0] as IngestInput;
}
const writesOf = (table: string) => state.inserts.filter((insert) => insert.table === table).flatMap((insert) => insert.rows);

function expectNothingRan(): void {
  expect(ingestSpy).not.toHaveBeenCalled();
  expect(state.inserts).toEqual([]);
  expect(state.llamaCalls).toBe(0);
  expect(state.embedCalls).toBe(0);
}

beforeEach(() => {
  state.mode = 'single-tenant';
  state.session = null;
  state.authThrows = false;
  state.sessionLookups = 0;
  state.members = [];
  state.admins = [];
  state.readOnly = false;
  state.inserts = [];
  state.llamaCalls = 0;
  state.embedCalls = 0;
  state.checkAdminCalls = 0;
  state.adminGuardQueries = 0;
  state.adminGuardFails = false;
  ingestSpy.mockReset();
  ingestSpy.mockResolvedValue(readyResult);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const id of [
    '@/lib/deployment-mode',
    '@/lib/supabase/server',
    '@/lib/supabase',
    '@/lib/auth/organization-handler',
    '@supabase/supabase-js',
    'node-fetch',
    '@/lib/admin-route-auth',
    '@/lib/rag',
  ]) {
    vi.doUnmock(id);
  }
});

describe('process-document write path: legacy', () => {
  it.each([undefined, 'legacy', 'bogus'])('RAG_INGEST_PIPELINE=%s keeps LlamaParse, the character chunker and storeDocument and never calls ingest', async (pipeline) => {
    state.session = { id: USER_B };
    const POST = await loadPost(pipeline);
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(state.llamaCalls).toBeGreaterThan(0);
    expect(state.inserts.map((entry) => entry.table)).toEqual(['documents', 'document_chunks']);
    expect(writesOf('documents')[0]).toMatchObject({ filename: 'notes.txt', user_id: USER_B });
    expect(String(writesOf('document_chunks')[0].content)).toBe('Document: notes.txt. Chunk 1 of 1. Content: Placeholder document body text.');
    expect(Object.keys(await response.json()).sort()).toEqual(['id', 'name', 'pages', 'successfulChunks', 'text', 'totalChunks', 'type']);
  });

  it('ignores upload_source and an admin cookie, never calls checkAdmin and keeps the legacy 400 for an oversized file', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    const POST = await loadPost('legacy');
    const stored = await POST(upload({ upload_source: 'config_upload', doc_type: 'bogus' }, { cookie: adminCookie(ADMIN_A) }));
    expect(stored.status).toBe(200);
    const oversized = await POST(upload({}, { bytes: new Uint8Array(21 * 1024 * 1024) }));
    expect(oversized.status).toBe(400);
    expect(state.checkAdminCalls).toBe(0);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});

describe('process-document write path: the session check comes first in both pipelines and both modes', () => {
  it.each(['legacy', 'unified'])('single-tenant, %s: no session returns 401 and nothing is parsed, ingested or stored', async (pipeline) => {
    const POST = await loadPost(pipeline);
    const response = await POST(upload());
    expect(response.status).toBe(401);
    expectNothingRan();
  });

  it.each(['legacy', 'unified'])('single-tenant, %s: a throwing session lookup returns 503 and nothing is parsed, ingested or stored', async (pipeline) => {
    state.authThrows = true;
    const POST = await loadPost(pipeline);
    const response = await POST(upload());
    expect(response.status).toBe(503);
    expectNothingRan();
  });

  it.each(['legacy', 'unified'])('multi-tenant, %s: no session returns 401 and nothing is parsed, ingested or stored', async (pipeline) => {
    state.mode = 'multi-tenant';
    const POST = await loadPost(pipeline);
    const response = await POST(upload());
    expect(response.status).toBe(401);
    expectNothingRan();
  });

  it('multi-tenant, unified: a throwing session lookup is not a success and nothing is parsed, ingested or stored', async () => {
    state.mode = 'multi-tenant';
    state.authThrows = true;
    const POST = await loadPost('unified');
    const response = await POST(upload());
    expect(response.ok).toBe(false);
    expectNothingRan();
  });

  it('multi-tenant, unified: a non-member organization returns 403 and ingest is not called', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    const response = await POST(upload({ organization_id: ORG_X }));
    expect(response.status).toBe(403);
    expectNothingRan();
  });

  it.each([
    ['valid admin cookie', () => adminCookie(ADMIN_A)],
    ['unsigned admin cookie (a bare admin id)', () => ADMIN_A],
    ['tampered admin cookie', () => `${adminCookie(ADMIN_A).slice(0, -4)}AAAA`],
  ])('%s with no session returns the existing 401 in both modes, and the admin lookup, parse, ingest and storeDocument never run', async (_label, makeCookie) => {
    for (const mode of ['single-tenant', 'multi-tenant'] as const) {
      state.mode = mode;
      state.admins = [ADMIN_A];
      const POST = await loadPost('unified');
      const response = await POST(upload({ upload_source: 'config_upload' }, { cookie: makeCookie() }));
      expect(response.status).toBe(401);
      expectNothingRan();
      expect(state.adminGuardQueries).toBe(0);
      expect(state.checkAdminCalls).toBe(0);
    }
  });
});

describe('process-document write path: unified chat_upload', () => {
  it('single-tenant: ingest gets source chat_upload, the s:default scope, the root source key, the file bytes and the request signal, and the route writes nothing itself', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    const input = lastIngest();
    expect(await keyOf(input.scope)).toBe('s:default');
    expect(input).toMatchObject({ source: 'chat_upload', sourceKey: 'root/notes.txt', filename: 'notes.txt', mimeType: 'text/plain' });
    expect(input.docType).toBeUndefined();
    expect(Buffer.from(input.file as Uint8Array).toString('utf8')).toBe(BODY);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(input.deadlineMs).toBeGreaterThan(0);
    expect(input.deadlineMs).toBeLessThan(60_000);
    expect(state.inserts).toEqual([]);
    expect(state.llamaCalls).toBe(0);
  });

  it('looks the session up once and never calls checkAdmin for a chat upload, even with an admin cookie', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    await POST(upload({}, { cookie: adminCookie(ADMIN_A) }));
    expect(state.sessionLookups).toBe(1);
    expect(state.checkAdminCalls).toBe(0);
    expect(lastIngest().source).toBe('chat_upload');
  });

  it('multi-tenant: a personal upload resolves u:<session user>', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    expect((await POST(upload())).status).toBe(200);
    expect(await keyOf(lastIngest().scope)).toBe(`u:${USER_B}`);
    expect(state.sessionLookups).toBe(1);
  });

  it('multi-tenant: a member organization resolves o:<organization> and a second organization the user is not in is refused', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    state.members = [{ organization_id: ORG_X, user_id: USER_B }];
    const POST = await loadPost('unified');
    expect((await POST(upload({ organization_id: ORG_X }))).status).toBe(200);
    expect(await keyOf(lastIngest().scope)).toBe(`o:${ORG_X}`);
    ingestSpy.mockClear();
    expect((await POST(upload({ organization_id: ORG_Y }))).status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('passes the picked doc_type and auto, and uses folder_id and the NFKC filename in the source key', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    await POST(upload({ doc_type: 'contract_legal', folder_id: 'folder-1' }, { name: 'ＡＢ report.txt' }));
    expect(lastIngest()).toMatchObject({ docType: 'contract_legal', sourceKey: 'folder-1/AB report.txt' });
    await POST(upload({ doc_type: 'auto' }));
    expect(lastIngest().docType).toBe('auto');
    await POST(upload({ doc_type: '' }));
    expect(lastIngest().docType).toBeUndefined();
  });

  it.each([
    ['doc_type', 'bogus'],
    ['upload_source', 'nango'],
    ['folder_id', 'x'.repeat(201)],
  ])('an invalid %s returns 400 with a structured error and nothing runs', async (field, value) => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    const response = await POST(upload({ [field]: value }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, error: 'Invalid request data' });
    expect(body.details.map((detail: { path: string }) => detail.path)).toEqual([field]);
    expectNothingRan();
  });

  it('a file over 20 MB returns 413 and an unsupported MIME type returns 415, before any parse', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    const large = await POST(upload({}, { bytes: new Uint8Array(21 * 1024 * 1024), name: 'big.pdf', type: 'application/pdf' }));
    expect(large.status).toBe(413);
    const unsupported = await POST(upload({}, { name: 'tool.exe', type: 'application/x-msdownload' }));
    expect(unsupported.status).toBe(415);
    const unnamed = await POST(upload({}, { name: 'noextension', type: '' }));
    expect(unnamed.status).toBe(415);
    expectNothingRan();
  });

  it('accepts a generic or empty browser MIME type when the extension is allowed and tells ingest the type of the extension', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    expect((await POST(upload({}, { name: 'readme.md', type: '' }))).status).toBe(200);
    expect(lastIngest().mimeType).toBe('text/markdown');
    expect((await POST(upload({}, { name: 'report.pdf', type: 'application/octet-stream' }))).status).toBe(200);
    expect(lastIngest().mimeType).toBe('application/pdf');
    expect((await POST(upload({}, { name: 'notes.txt', type: 'text/plain; charset=utf-8' }))).status).toBe(200);
    expect(lastIngest().mimeType).toBe('text/plain');
  });

  it('answers a ready document with today\'s fields plus status, version and parserUsed', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: DOCUMENT,
      documentId: DOCUMENT,
      name: 'notes.txt',
      filename: 'notes.txt',
      type: 'txt',
      successfulChunks: 3,
      totalChunks: 3,
      status: 'ready',
      version: 1,
      parserUsed: 'text',
    });
  });

  it('answers processing with 202 and the document id, a duplicate with the existing document id, and a failure with a generic 500', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost('unified');
    ingestSpy.mockResolvedValueOnce({ ...readyResult, status: 'processing', chunkCount: 0 });
    const pending = await POST(upload());
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ id: DOCUMENT, documentId: DOCUMENT, status: 'processing' });

    ingestSpy.mockResolvedValueOnce({ ...readyResult, status: 'skipped_duplicate', documentId: null, version: null, duplicateOf: DUPLICATE_OF });
    const duplicate = await POST(upload());
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ id: DUPLICATE_OF, documentId: DUPLICATE_OF, status: 'skipped_duplicate', version: null });

    ingestSpy.mockResolvedValueOnce({ ...readyResult, status: 'failed', documentId: null, version: null, chunkCount: 0, reason: 'no_parser_available' });
    const failed = await POST(upload());
    expect(failed.status).toBe(500);
    const body = await failed.json();
    expect(body).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(body)).not.toContain('no_parser_available');
  });

  it('a throwing ingest returns a generic 500 without the error text', async () => {
    state.session = { id: USER_B };
    ingestSpy.mockRejectedValueOnce(new Error('secret-detail-placeholder'));
    const POST = await loadPost('unified');
    const response = await POST(upload());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret-detail-placeholder');
  });

  it('isTemporary keeps the legacy parse call, persists nothing and never calls ingest or checkAdmin', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    const response = await POST(upload({ upload_source: 'config_upload' }, { temporary: true, cookie: adminCookie(ADMIN_A) }));
    expect(response.status).toBe(200);
    expect(state.llamaCalls).toBeGreaterThan(0);
    expect(ingestSpy).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
    expect(state.checkAdminCalls).toBe(0);
    expect(await response.json()).toMatchObject({ name: 'notes.txt', text: 'Placeholder document body text.' });
  });

  it('single-tenant: the owner-or-admin rule still refuses a non-admin while read_only_doc_dashboard is on, before ingest', async () => {
    state.session = { id: USER_B };
    state.readOnly = true;
    const POST = await loadPost('unified');
    const response = await POST(upload());
    expect(response.status).toBe(403);
    expectNothingRan();
  });
});

describe('process-document write path: unified config_upload (T-03-88, T-03-150)', () => {
  it('the session of admin A with a valid signed cookie for A gives config_upload and the admin workspace scope', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    expect((await POST(upload({ upload_source: 'config_upload' }, { cookie: adminCookie(ADMIN_A) }))).status).toBe(200);
    expect(state.checkAdminCalls).toBe(1);
    expect(lastIngest().source).toBe('config_upload');
    expect(await keyOf(lastIngest().scope)).toBe('s:default');
  });

  it('the session of admin A alone, with no cookie, gives config_upload; multi-tenant gives the admin personal scope and a member organization its own', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    state.members = [{ organization_id: ORG_X, user_id: ADMIN_A }];
    const POST = await loadPost('unified');
    expect((await POST(upload({ upload_source: 'config_upload' }))).status).toBe(200);
    expect(lastIngest().source).toBe('config_upload');
    expect(await keyOf(lastIngest().scope)).toBe(`u:${ADMIN_A}`);
    expect((await POST(upload({ upload_source: 'config_upload', organization_id: ORG_X }))).status).toBe(200);
    expect(await keyOf(lastIngest().scope)).toBe(`o:${ORG_X}`);
    ingestSpy.mockClear();
    expect((await POST(upload({ upload_source: 'config_upload', organization_id: ORG_Y }))).status).toBe(403);
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('a non-admin session sending upload_source=config_upload gives chat_upload with the session scope', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    expect((await POST(upload({ upload_source: 'config_upload' }))).status).toBe(200);
    expect(state.checkAdminCalls).toBe(1);
    expect(lastIngest().source).toBe('chat_upload');
    expect(await keyOf(lastIngest().scope)).toBe(`u:${USER_B}`);
  });

  it.each([
    ['a bare admin id', () => ADMIN_A],
    ['a tampered signature', () => `${adminCookie(ADMIN_A).slice(0, -4)}AAAA`],
    ['an expired value', () => mintAdminSessionValue(ADMIN_A, { serviceKey: SERVICE_KEY, nowMs: Date.now() - 24 * 3600 * 1000 }) as string],
    ['a value signed with another key', () => mintAdminSessionValue(ADMIN_A, { serviceKey: 'another-key-placeholder' }) as string],
  ])('a forged cookie (%s) with a non-admin session gives chat_upload and never config_upload', async (_label, makeCookie) => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    expect((await POST(upload({ upload_source: 'config_upload' }, { cookie: makeCookie() }))).status).toBe(200);
    expect(lastIngest().source).toBe('chat_upload');
    expect(await keyOf(lastIngest().scope)).toBe(`u:${USER_B}`);
  });

  it('a valid cookie for admin A sent with the session of non-admin B gives chat_upload with B\'s scope', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    expect((await POST(upload({ upload_source: 'config_upload' }, { cookie: adminCookie(ADMIN_A) }))).status).toBe(200);
    expect(lastIngest().source).toBe('chat_upload');
    expect(await keyOf(lastIngest().scope)).toBe(`u:${USER_B}`);
  });

  it('a bearer token of another admin cannot turn a different session user into config_upload', async () => {
    state.mode = 'multi-tenant';
    state.session = { id: USER_B };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    const response = await POST(upload({ upload_source: 'config_upload' }, { headers: { authorization: 'Bearer placeholder-token' } }));
    expect(response.status).toBe(200);
    expect(lastIngest().source).toBe('chat_upload');
    expect(await keyOf(lastIngest().scope)).toBe(`u:${USER_B}`);
  });

  it('an admin lookup failure (checkAdmin 503) returns 503 with a JSON error and nothing is parsed, ingested or stored', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    state.adminGuardFails = true;
    const POST = await loadPost('unified');
    const response = await POST(upload({ upload_source: 'config_upload' }, { cookie: adminCookie(ADMIN_A) }));
    expect(response.status).toBe(503);
    expect(typeof (await response.json()).error).toBe('string');
    expectNothingRan();
  });

  it('config_upload honours the form doc_type and folder, and the 20 MB and MIME limits apply to it as well', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    const POST = await loadPost('unified');
    expect((await POST(upload({ upload_source: 'config_upload', doc_type: 'invoice_receipt', folder_id: 'inbox' }))).status).toBe(200);
    expect(lastIngest()).toMatchObject({ source: 'config_upload', docType: 'invoice_receipt', sourceKey: 'inbox/notes.txt' });
    ingestSpy.mockClear();
    expect((await POST(upload({ upload_source: 'config_upload' }, { name: 'tool.exe', type: 'application/x-msdownload' }))).status).toBe(415);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});
