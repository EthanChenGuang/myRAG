import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const DOC_A = '00000000-0000-4000-8000-00000000d001';
const DOC_B = '00000000-0000-4000-8000-00000000d002';
const DOC_ORG = '00000000-0000-4000-8000-00000000d003';
const DOC_SINGLE = '00000000-0000-4000-8000-00000000d004';
const DOC_UNKNOWN = '00000000-0000-4000-8000-00000000dfff';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
const SECRET_FILENAME = 'quartz-seventeen-handbook.pdf';

type Row = Record<string, unknown>;

interface DocRow {
  id: string;
  tenant_key: string;
  status: string;
  version: number;
  processing_status: string | null;
  processing_state: Record<string, unknown>;
  filename: string;
  doc_type: string;
  parser_used: string | null;
  created_at: string;
  is_current: boolean;
}

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  authThrows: false,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  admins: [] as string[],
  docs: [] as DocRow[],
  calls: [] as Call[],
  rpcFails: false,
  now: NOW,
};

function docRow(id: string, tenantKey: string, overrides: Partial<DocRow> = {}): DocRow {
  return {
    id,
    tenant_key: tenantKey,
    status: 'processing',
    version: 1,
    processing_status: 'processing',
    processing_state: { lastCompleted: 'store_original' },
    filename: SECRET_FILENAME,
    doc_type: 'general',
    parser_used: 'docling',
    created_at: new Date(NOW - HOUR).toISOString(),
    is_current: false,
    ...overrides,
  };
}

function respond(data: Row[] | null, error: { code: string; message: string } | null = null): RpcRequest {
  const response: RpcResponse = { data, error };
  const request: RpcRequest = {
    abortSignal: () => request,
    then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
  };
  return request;
}

function fakeDb(): RpcClient {
  return {
    rpc(fn, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      state.calls.push({ fn, args: a });
      if (state.rpcFails) return respond(null, { code: 'XX000', message: `boom ${SECRET_FILENAME}` });
      const row = state.docs.find((doc) => doc.id === a.p_document_id && doc.tenant_key === a.p_tenant_key);
      if (fn === 'rag_get_ingest_document') return respond(row ? [{ ...row } as unknown as Row] : []);
      if (fn === 'rag_get_ingest_origin') {
        return respond(row ? [{ lineage_id: row.id, original_path: null, source: 'config_upload', source_key: 'root/a.pdf' }] : []);
      }
      if (fn === 'rag_mark_document_failed') {
        if (!row) return respond(null, { code: 'P0001', message: 'tenant_mismatch' });
        if (row.is_current) return respond(null, { code: 'P0001', message: 'document_is_current' });
        row.status = 'failed';
        row.processing_status = 'failed';
        row.processing_state = { ...row.processing_state, failure_reason: a.p_reason };
        return respond([{ document_id: row.id, status: 'failed' }]);
      }
      return respond([]);
    },
  };
}

function callsOf(fn: string): Call[] {
  return state.calls.filter((call) => call.fn === fn);
}

function memberAndAdminDb() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        abortSignal: () => query,
        maybeSingle() {
          if (table === 'admin_users') {
            return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
          }
          const member = state.members.find(
            (entry) => entry.organization_id === filters.organization_id && entry.user_id === filters.user_id,
          );
          return Promise.resolve({ data: member ? { organization_id: member.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

let resumeSpy: ReturnType<typeof vi.fn>;

async function loadRoutes() {
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
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    resumeSpy = vi.fn(actual.resumeIngest);
    return { ...actual, resumeIngest: resumeSpy };
  });
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memberAndAdminDb(), supabaseAdmin: memberAndAdminDb() }));
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ db: () => fakeDb(), now: () => state.now, rehydrate: async () => false });
  const status = await import('@/app/api/rag/ingest/[id]/route');
  const resume = await import('@/app/api/rag/ingest/[id]/resume/route');
  return { GET: status.GET, POST: resume.POST };
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string, query = '') => new NextRequest(`http://localhost/api/rag/ingest/${id}${query}`);
const post = (id: string, query = '') => new NextRequest(`http://localhost/api/rag/ingest/${id}/resume${query}`, { method: 'POST' });

const STAGE_WRITES = ['rag_save_ingest_state', 'rag_write_chunks', 'rag_publish_document_version', 'rag_mark_document_failed', 'rag_set_document_fields'];

function writesMade(): string[] {
  return state.calls.filter((call) => STAGE_WRITES.includes(call.fn)).map((call) => call.fn);
}

let logged: string[] = [];

describe('GET /api/rag/ingest/[id]', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = null;
    state.authThrows = false;
    state.members = [];
    state.admins = [];
    state.calls = [];
    state.rpcFails = false;
    state.now = NOW;
    state.docs = [
      docRow(DOC_A, `u:${USER_A}`, { processing_state: { lastCompleted: 'store_original', parseJob: { parser: 'docling', jobId: 'job1', submittedAt: 'x', attempt: 1 } } }),
      docRow(DOC_B, `u:${USER_B}`),
      docRow(DOC_ORG, `o:${ORG_X}`),
      docRow(DOC_SINGLE, 's:default'),
    ];
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/deployment-mode');
    vi.doUnmock('@/lib/rag');
  });

  it('answers 401 with no session in multi-tenant mode and reads nothing', async () => {
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it('answers 401 with no session in single-tenant mode too', async () => {
    state.mode = 'single-tenant';
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_SINGLE), ctx(DOC_SINGLE));
    expect(response.status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(503);
    expect(state.calls).toEqual([]);
  });

  it('returns the status object of the owner own document and nothing else', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: 'processing',
      version: 1,
      processingStatus: 'processing',
      lastCompleted: 'store_original',
      parserUsed: 'docling',
      docType: 'general',
      warnings: ['parse_pending'],
    });
    expect(JSON.stringify(body)).not.toContain(SECRET_FILENAME);
    expect(JSON.stringify(body)).not.toContain('job1');
  });

  it('answers 404 for another tenant document with the same body as for an unknown id', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoutes();
    const foreign = await GET(get(DOC_B), ctx(DOC_B));
    const unknown = await GET(get(DOC_UNKNOWN), ctx(DOC_UNKNOWN));
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(writesMade()).toEqual([]);
  });

  it('answers 400 with a structured error for a malformed id and reads nothing', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoutes();
    const response = await GET(get('not-a-uuid'), ctx('not-a-uuid'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
    expect(state.calls).toEqual([]);
  });

  it('honours an organization query parameter only through the membership check', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoutes();

    const notMember = await GET(get(DOC_ORG, `?organizationId=${ORG_X}`), ctx(DOC_ORG));
    expect(notMember.status).toBe(403);
    expect(state.calls).toEqual([]);

    const personal = await GET(get(DOC_ORG), ctx(DOC_ORG));
    expect(personal.status).toBe(404);

    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const member = await GET(get(DOC_ORG, `?organizationId=${ORG_X}`), ctx(DOC_ORG));
    expect(member.status).toBe(200);
    expect((await member.json()).status).toBe('processing');
    expect(callsOf('rag_get_ingest_document').at(-1)?.args.p_tenant_key).toBe(`o:${ORG_X}`);
  });

  it('marks a version that has been processing for more than 24 hours as failed, with reason stale_processing', async () => {
    state.session = { id: USER_A };
    state.docs[0] = docRow(DOC_A, `u:${USER_A}`, { created_at: new Date(NOW - 24 * HOUR - 1000).toISOString() });
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('failed');
    expect(body.processingStatus).toBe('failed');
    expect(body.reason).toBe('stale_processing');
    expect(callsOf('rag_mark_document_failed')).toHaveLength(1);
    expect(callsOf('rag_mark_document_failed')[0]?.args).toMatchObject({ p_document_id: DOC_A, p_tenant_key: `u:${USER_A}`, p_reason: 'stale_processing' });
    expect(state.docs[0]?.status).toBe('failed');

    const again = await GET(get(DOC_A), ctx(DOC_A));
    expect((await again.json()).reason).toBe('stale_processing');
    expect(callsOf('rag_mark_document_failed')).toHaveLength(1);
  });

  it('leaves alone a processing version at or under 24 hours, and every settled version however old', async () => {
    state.session = { id: USER_A };
    const tenant = `u:${USER_A}`;
    const ids = ['00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000e003', '00000000-0000-4000-8000-00000000e004', '00000000-0000-4000-8000-00000000e005'] as const;
    const old = new Date(NOW - 30 * 24 * HOUR).toISOString();
    state.docs = [
      docRow(ids[0], tenant, { created_at: new Date(NOW - 24 * HOUR + 1000).toISOString() }),
      docRow(ids[1], tenant, { created_at: new Date(NOW - 24 * HOUR).toISOString() }),
      docRow(ids[2], tenant, { status: 'ready', processing_status: 'ready', is_current: true, created_at: old }),
      docRow(ids[3], tenant, { status: 'failed', processing_status: 'failed', created_at: old, processing_state: { failure_reason: 'parse_failed' } }),
      docRow(ids[4], tenant, { created_at: 'not a timestamp' }),
    ];
    const { GET } = await loadRoutes();
    const statuses: string[] = [];
    for (const id of ids) {
      const response = await GET(get(id), ctx(id));
      expect(response.status).toBe(200);
      statuses.push((await response.json()).status);
    }
    expect(statuses).toEqual(['processing', 'processing', 'ready', 'failed', 'processing']);
    expect(callsOf('rag_mark_document_failed')).toEqual([]);
  });

  it('does not reap, report or log another tenant stale row when the caller asks for it', async () => {
    state.session = { id: USER_A };
    state.docs = [
      docRow(DOC_A, `u:${USER_A}`),
      docRow(DOC_B, `u:${USER_B}`, { created_at: new Date(NOW - 48 * HOUR).toISOString() }),
    ];
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_B), ctx(DOC_B));
    expect(response.status).toBe(404);
    expect(callsOf('rag_mark_document_failed')).toEqual([]);
    expect(state.docs[1]?.status).toBe('processing');
    expect(logged.join('\n')).not.toContain(DOC_B);
  });

  it('logs the id of a reaped version and no filename or text', async () => {
    state.session = { id: USER_A };
    state.docs[0] = docRow(DOC_A, `u:${USER_A}`, { created_at: new Date(NOW - 25 * HOUR).toISOString() });
    const { GET } = await loadRoutes();
    await GET(get(DOC_A), ctx(DOC_A));
    const text = logged.join('\n');
    expect(text).toContain(DOC_A);
    expect(text).not.toContain(SECRET_FILENAME);
  });

  it('answers 503 without echoing the database message when the lookup fails', async () => {
    state.session = { id: USER_A };
    state.rpcFails = true;
    const { GET } = await loadRoutes();
    const response = await GET(get(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain(SECRET_FILENAME);
    expect(logged.join('\n')).not.toContain(SECRET_FILENAME);
  });
});

describe('POST /api/rag/ingest/[id]/resume', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = null;
    state.authThrows = false;
    state.members = [];
    state.admins = [];
    state.calls = [];
    state.rpcFails = false;
    state.now = NOW;
    state.docs = [
      docRow(DOC_A, `u:${USER_A}`),
      docRow(DOC_B, `u:${USER_B}`),
      docRow(DOC_ORG, `o:${ORG_X}`, { status: 'ready', processing_status: 'ready', is_current: true, processing_state: { lastCompleted: 'publish', chunkCount: 4 } }),
      docRow(DOC_SINGLE, 's:default'),
    ];
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/deployment-mode');
    vi.doUnmock('@/lib/rag');
  });

  it('answers 401 with no session and runs nothing', async () => {
    const { POST } = await loadRoutes();
    const response = await POST(post(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(401);
    expect(state.calls).toEqual([]);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('answers 401 with no session in single-tenant mode too', async () => {
    state.mode = 'single-tenant';
    const { POST } = await loadRoutes();
    const response = await POST(post(DOC_SINGLE), ctx(DOC_SINGLE));
    expect(response.status).toBe(401);
    expect(state.calls).toEqual([]);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('answers 404 for another tenant id exactly as for an unknown id, and writes nothing', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoutes();
    const foreign = await POST(post(DOC_B), ctx(DOC_B));
    const unknown = await POST(post(DOC_UNKNOWN), ctx(DOC_UNKNOWN));
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(writesMade()).toEqual([]);
    expect(state.docs[1]?.status).toBe('processing');
  });

  it('answers 400 for a malformed id before any lookup', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoutes();
    const response = await POST(post('nope'), ctx('nope'));
    expect(response.status).toBe(400);
    expect((await response.json()).success).toBe(false);
    expect(state.calls).toEqual([]);
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it('continues a processing document through resumeIngest with the caller scope and returns its result', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoutes();
    const response = await POST(post(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(200);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    const [scope, documentId] = resumeSpy.mock.calls[0] as [{ kind: string; userId: string | null }, string];
    expect(scope).toMatchObject({ kind: 'personal', userId: USER_A });
    expect(documentId).toBe(DOC_A);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'processing', documentId: DOC_A, version: 1, reason: 'resume_input_unavailable' });
    expect(JSON.stringify(body)).not.toContain(SECRET_FILENAME);
  });

  it('returns ready for a ready document without running a stage', async () => {
    state.session = { id: USER_A };
    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const { POST } = await loadRoutes();
    const response = await POST(post(DOC_ORG, `?organizationId=${ORG_X}`), ctx(DOC_ORG));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', documentId: DOC_ORG, chunkCount: 4 });
    expect(writesMade()).toEqual([]);
  });

  it('refuses an organization the caller is not a member of before resuming anything', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoutes();
    const response = await POST(post(DOC_ORG, `?organizationId=${ORG_X}`), ctx(DOC_ORG));
    expect(response.status).toBe(403);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it('in single-tenant mode lets only an administrator resume', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    const { POST } = await loadRoutes();
    const refused = await POST(post(DOC_SINGLE), ctx(DOC_SINGLE));
    expect(refused.status).toBe(403);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);

    state.admins = [USER_A];
    const allowed = await POST(post(DOC_SINGLE), ctx(DOC_SINGLE));
    expect(allowed.status).toBe(200);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(callsOf('rag_get_ingest_document')[0]?.args.p_tenant_key).toBe('s:default');
  });

  it('maps a settled failure of the resume call itself to 503 without echoing database text', async () => {
    state.session = { id: USER_A };
    state.rpcFails = true;
    const { POST } = await loadRoutes();
    const response = await POST(post(DOC_A), ctx(DOC_A));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET_FILENAME);
    expect(logged.join('\n')).not.toContain(SECRET_FILENAME);
  });
});
