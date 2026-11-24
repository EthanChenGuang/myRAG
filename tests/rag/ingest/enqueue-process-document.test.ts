import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueResult } from '@/lib/rag/ingest/enqueue';
import type { IngestInput } from '@/lib/rag/ingest';
import { mintAdminSessionValue } from '@/lib/admin-session';

const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000e1';
const JOB = '00000000-0000-4000-8000-0000000000f1';
const SERVICE_KEY = 'test-service-role-key-placeholder';
const BODY = 'First placeholder paragraph.\n\nSecond placeholder paragraph.';

const afterMock = vi.hoisted(() => vi.fn((task: () => Promise<void>) => void task()));
const scheduleWakeMock = vi.hoisted(() => vi.fn());
const submitSpy = vi.hoisted(() => vi.fn<(input: IngestInput) => Promise<EnqueueResult>>());
const ingestSpy = vi.hoisted(() => vi.fn<(input: IngestInput) => Promise<unknown>>());

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
  llamaCalls: 0,
  checkAdminCalls: 0,
  adminGuardFails: false,
  parseCalls: 0,
};

function routeAdmin() {
  return {
    from() {
      const builder = {
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => builder,
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
          if (state.adminGuardFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
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
          const row = state.members.find((m) => m.organization_id === filters.organization_id && m.user_id === filters.user_id);
          return Promise.resolve({ data: row ? { organization_id: row.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

const queued: EnqueueResult = { jobId: JOB, documentId: DOCUMENT, status: 'queued' };

async function loadPost(asyncOn: boolean): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  vi.stubEnv('LLAMA_CLOUD_API_KEY', 'test-llama-key-placeholder');
  vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
  vi.stubEnv('RAG_INGEST_ASYNC', asyncOn ? 'on' : 'off');
  vi.stubEnv('RAG_SIDECAR_URL', 'http://127.0.0.1:9199');
  vi.stubEnv('RAG_SIDECAR_SECRET', 'wake-sidecar-secret-placeholder-00');
  vi.doMock('next/server', async (importOriginal) => {
    const original = await importOriginal<typeof import('next/server')>();
    return { ...original, after: afterMock };
  });
  vi.doMock('@/lib/rag/ingest/wake', () => ({ scheduleIngestWake: scheduleWakeMock }));
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
      hasAccess: state.members.some((m) => m.user_id === userId && m.organization_id === organizationId),
    }),
  }));
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => routeAdmin() }));
  vi.doMock('node-fetch', () => ({
    default: async () => {
      state.llamaCalls += 1;
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ id: 'job-1', status: 'SUCCESS', markdown: 'x', chunks: ['x'] }), text: async () => '' };
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
      submitIngest: (input: IngestInput) => submitSpy(input),
      ingest: (input: IngestInput) => ingestSpy(input),
      embedText: async () => [0.1, 0.2],
    };
  });
  vi.doMock('@/lib/rag/ingest/parsers/llamaparse-v2', () => ({
    parseWithLlamaParse: async () => {
      state.parseCalls += 1;
      return { text: 'parsed' };
    },
  }));
  const { setRagDepsForTests } = await import('@/lib/rag/deps');
  setRagDepsForTests({ adminClient: () => membershipAdmin() as never });
  const { POST } = await import('@/app/api/process-document/route');
  return POST;
}

function upload(fields: Record<string, string> = {}, options: { temporary?: boolean; cookie?: string; name?: string; type?: string; bytes?: Uint8Array } = {}): Request {
  const form = new FormData();
  form.append('file', new File([(options.bytes ?? BODY) as BlobPart], options.name ?? 'report.pdf', { type: options.type ?? 'application/pdf' }));
  form.append('isTemporary', String(options.temporary ?? false));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request('http://localhost/api/process-document', {
    method: 'POST',
    body: form,
    headers: options.cookie ? { cookie: `admin_session=${options.cookie}` } : {},
  });
}

const adminCookie = (userId: string) => mintAdminSessionValue(userId, { serviceKey: SERVICE_KEY }) as string;

function expectNothingEnqueued(): void {
  expect(submitSpy).not.toHaveBeenCalled();
  expect(state.llamaCalls).toBe(0);
  expect(state.parseCalls).toBe(0);
}

beforeEach(() => {
  state.mode = 'single-tenant';
  state.session = null;
  state.authThrows = false;
  state.sessionLookups = 0;
  state.members = [];
  state.admins = [];
  state.readOnly = false;
  state.llamaCalls = 0;
  state.checkAdminCalls = 0;
  state.adminGuardFails = false;
  state.parseCalls = 0;
  submitSpy.mockReset();
  ingestSpy.mockReset();
  scheduleWakeMock.mockReset();
  afterMock.mockClear();
  submitSpy.mockResolvedValue(queued);
  ingestSpy.mockResolvedValue({
    status: 'ready',
    documentId: DOCUMENT,
    version: 1,
    parserUsed: 'text',
    chunkCount: 3,
    warnings: [],
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('process-document enqueue path (RAG_INGEST_ASYNC=on)', () => {
  it('returns 202 with jobId, documentId and queued without calling a parser during the request', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost(true);
    const response = await POST(upload());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ jobId: JOB, documentId: DOCUMENT, status: 'queued' });
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(state.parseCalls).toBe(0);
    expect(state.llamaCalls).toBe(0);
    expect(scheduleWakeMock).toHaveBeenCalledTimes(1);
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('registers after() for the wake without blocking the response body', async () => {
    state.session = { id: USER_B };
    scheduleWakeMock.mockImplementation(() => {
      afterMock(() => Promise.resolve());
    });
    const POST = await loadPost(true);
    await POST(upload());
    expect(scheduleWakeMock).toHaveBeenCalledTimes(1);
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it.each(['single-tenant', 'multi-tenant'] as const)('%s: no session returns 401 before submitIngest', async (mode) => {
    state.mode = mode;
    const POST = await loadPost(true);
    const response = await POST(upload());
    expect(response.status).toBe(401);
    expectNothingEnqueued();
  });

  it('single-tenant: a throwing session lookup returns 503 before submitIngest', async () => {
    state.authThrows = true;
    const POST = await loadPost(true);
    const response = await POST(upload());
    expect(response.status).toBe(503);
    expectNothingEnqueued();
  });

  it('multi-tenant: a throwing session lookup fails before submitIngest', async () => {
    state.mode = 'multi-tenant';
    state.authThrows = true;
    const POST = await loadPost(true);
    expect((await POST(upload())).ok).toBe(false);
    expectNothingEnqueued();
  });

  it('skipped_duplicate returns 200 with the existing document id and does not wake', async () => {
    state.session = { id: USER_B };
    submitSpy.mockResolvedValueOnce({ jobId: JOB, documentId: DOCUMENT, status: 'skipped_duplicate' });
    const POST = await loadPost(true);
    const response = await POST(upload());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ documentId: DOCUMENT, status: 'skipped_duplicate' });
    expect(scheduleWakeMock).not.toHaveBeenCalled();
  });

  it('isTemporary never calls submitIngest', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost(true);
    const response = await POST(upload({}, { temporary: true }));
    expect(response.status).toBe(200);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(state.llamaCalls).toBeGreaterThan(0);
  });

  it('config_upload with a valid admin session enqueues config_upload', async () => {
    state.session = { id: ADMIN_A };
    state.admins = [ADMIN_A];
    const POST = await loadPost(true);
    expect((await POST(upload({ upload_source: 'config_upload' }, { cookie: adminCookie(ADMIN_A) }))).status).toBe(202);
    expect(submitSpy.mock.calls[0]?.[0]?.source).toBe('config_upload');
    expect(state.checkAdminCalls).toBe(1);
  });

  it('an invalid doc_type returns 400 before submitIngest', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost(true);
    const response = await POST(upload({ doc_type: 'bogus' }));
    expect(response.status).toBe(400);
    expectNothingEnqueued();
  });

  it('with async off the route calls ingest, not submitIngest (write-path tests cover full behaviour)', async () => {
    state.session = { id: USER_B };
    const POST = await loadPost(false);
    const response = await POST(upload({}, { name: 'notes.txt', type: 'text/plain' }));
    expect(response.status).toBe(200);
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(scheduleWakeMock).not.toHaveBeenCalled();
  });
});