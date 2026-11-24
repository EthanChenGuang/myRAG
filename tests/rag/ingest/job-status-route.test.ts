import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobSettingsSnapshotSchema } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const JOB_A = '10000000-0000-4000-8000-000000000001';
const JOB_B = '10000000-0000-4000-8000-000000000002';
const JOB_ORG = '10000000-0000-4000-8000-000000000003';
const JOB_SINGLE = '10000000-0000-4000-8000-000000000004';
const JOB_UNKNOWN = '10000000-0000-4000-8000-00000000ffff';
const DOC_A = '00000000-0000-4000-8000-00000000d001';
const SECRET_FILENAME = 'hidden-ingest-filename.pdf';

type Row = Record<string, unknown>;

interface JobRow {
  id: string;
  tenant_key: string;
  status: string;
  stage: string | null;
  document_id: string | null;
  error_class: string | null;
  needs_review_reason: string | null;
  provisional_published_at: string | null;
  updated_at: string;
  settings: Record<string, unknown>;
  filename: string | null;
  source_key: string;
}

type Call = { fn: string; args: Record<string, unknown> };

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  authThrows: false,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  jobs: [] as JobRow[],
  calls: [] as Call[],
  rpcFails: false,
};

function jobSettings(): Record<string, unknown> {
  return JobSettingsSnapshotSchema.parse(
    buildJobSettings({
      queueConfig: loadQueueConfig({}),
      profile: getProcessingProfile('general'),
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig: loadRoutingConfig(),
    }),
  ) as unknown as Record<string, unknown>;
}

function jobRow(id: string, tenantKey: string, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id,
    tenant_key: tenantKey,
    status: 'queued',
    stage: 'preflight',
    document_id: DOC_A,
    error_class: null,
    needs_review_reason: null,
    provisional_published_at: null,
    updated_at: '2026-11-24T12:00:00.000Z',
    settings: jobSettings(),
    filename: SECRET_FILENAME,
    source_key: 'secret/source/key',
    ...overrides,
  };
}

function fullJobRow(row: JobRow): Row {
  return {
    ...row,
    kind: 'ingest',
    source: 'config_upload',
    priority: 100,
    retries: 0,
    max_retries: 3,
    escalations: 0,
    attempts: [],
    page_ranges: [],
    tier_page_counts: {},
    detect_counts: null,
    timings: {},
    stage_state: {},
    created_at: '2026-11-24T11:00:00.000Z',
    deleted_at: null,
    lease_until: null,
    run_after: null,
    locked_by: null,
    runner: null,
    batch_id: null,
    lineage_id: null,
    version: null,
    file_sha256: null,
    mime_type: null,
    original_ref: null,
    doc_class: null,
    tier: null,
    parser_used: null,
    parser_version: null,
    pages: null,
    preflight_ref: null,
    est_cost_usd: null,
    embedding_profile: null,
    routing_note: null,
    trace_id: null,
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
      if (fn === 'rag_get_ingestion_job') {
        const row = state.jobs.find((job) => job.id === a.p_job_id && job.tenant_key === a.p_tenant_key);
        return respond(row ? [fullJobRow(row)] : []);
      }
      return respond([]);
    },
  };
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
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => memberAndAdminDb() }));
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ db: () => fakeDb() });
  const route = await import('@/app/api/rag/ingest/jobs/[id]/route');
  return route.GET;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (id: string, query = '') => new NextRequest(`http://localhost/api/rag/ingest/jobs/${id}${query}`);

describe('GET /api/rag/ingest/jobs/[id]', () => {
  beforeEach(() => {
    state.mode = 'multi-tenant';
    state.session = null;
    state.authThrows = false;
    state.members = [];
    state.calls = [];
    state.rpcFails = false;
    state.jobs = [
      jobRow(JOB_A, `u:${USER_A}`),
      jobRow(JOB_B, `u:${USER_B}`),
      jobRow(JOB_ORG, `o:${ORG_X}`),
      jobRow(JOB_SINGLE, 's:default'),
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/deployment-mode');
  });

  it('answers 401 with no session and reads nothing', async () => {
    const GET = await loadRoute();
    const response = await GET(req(JOB_A), ctx(JOB_A));
    expect(response.status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const GET = await loadRoute();
    const response = await GET(req(JOB_A), ctx(JOB_A));
    expect(response.status).toBe(503);
    expect(state.calls).toEqual([]);
  });

  it('returns the owner job status with exactly the public fields and Cache-Control no-store', async () => {
    state.session = { id: USER_A };
    state.jobs[0] = jobRow(JOB_A, `u:${USER_A}`, {
      status: 'parsing',
      stage: 'parse',
      provisional_published_at: '2026-11-24T11:30:00.000Z',
    });
    const GET = await loadRoute();
    const response = await GET(req(JOB_A), ctx(JOB_A));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({
      jobId: JOB_A,
      documentId: DOC_A,
      status: 'parsing',
      stage: 'parse',
      provisional: true,
      needsReview: false,
      reason: null,
      updatedAt: '2026-11-24T12:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain(SECRET_FILENAME);
    expect(JSON.stringify(body)).not.toContain('secret/source');
    expect(JSON.stringify(body)).not.toContain('settings');
  });

  it('answers 404 for another tenant job with the same body as for an unknown id', async () => {
    state.session = { id: USER_A };
    const GET = await loadRoute();
    const foreign = await GET(req(JOB_B), ctx(JOB_B));
    const unknown = await GET(req(JOB_UNKNOWN), ctx(JOB_UNKNOWN));
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
  });

  it('answers 400 with a structured error for a malformed id and reads nothing', async () => {
    state.session = { id: USER_A };
    const GET = await loadRoute();
    const response = await GET(req('not-a-uuid'), ctx('not-a-uuid'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(Array.isArray(body.details)).toBe(true);
    expect(state.calls).toEqual([]);
  });

  it('honours an organization query parameter only through the membership check', async () => {
    state.session = { id: USER_A };
    const GET = await loadRoute();

    const notMember = await GET(req(JOB_ORG, `?organizationId=${ORG_X}`), ctx(JOB_ORG));
    expect(notMember.status).toBe(403);
    expect(state.calls).toEqual([]);

    const personal = await GET(req(JOB_ORG), ctx(JOB_ORG));
    expect(personal.status).toBe(404);

    state.members = [{ organization_id: ORG_X, user_id: USER_A }];
    const member = await GET(req(JOB_ORG, `?organizationId=${ORG_X}`), ctx(JOB_ORG));
    expect(member.status).toBe(200);
    expect((await member.json()).status).toBe('queued');
    expect(state.calls.at(-1)?.args.p_tenant_key).toBe(`o:${ORG_X}`);
  });

  it('in single-tenant mode any signed-in user reads s:default jobs', async () => {
    state.mode = 'single-tenant';
    state.session = { id: USER_A };
    const GET = await loadRoute();
    const response = await GET(req(JOB_SINGLE), ctx(JOB_SINGLE));
    expect(response.status).toBe(200);
    expect((await response.json()).jobId).toBe(JOB_SINGLE);
    expect(state.calls[0]?.args.p_tenant_key).toBe('s:default');
  });

  it('exposes failed jobs with error_class and needs_review jobs with needsReview', async () => {
    state.session = { id: USER_A };
    state.jobs[0] = jobRow(JOB_A, `u:${USER_A}`, { status: 'failed', error_class: 'parse_failed', stage: null });
    const GET = await loadRoute();
    const failed = await GET(req(JOB_A), ctx(JOB_A));
    expect((await failed.json()).reason).toBe('parse_failed');

    state.jobs[0] = jobRow(JOB_A, `u:${USER_A}`, {
      status: 'needs_review',
      needs_review_reason: 'low_confidence',
      stage: 'check',
    });
    const review = await GET(req(JOB_A), ctx(JOB_A));
    const body = await review.json();
    expect(body.needsReview).toBe(true);
    expect(body.reason).toBe('low_confidence');
  });

  it('answers 503 without echoing database content when the lookup fails', async () => {
    state.session = { id: USER_A };
    state.rpcFails = true;
    const GET = await loadRoute();
    const response = await GET(req(JOB_A), ctx(JOB_A));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET_FILENAME);
  });
});