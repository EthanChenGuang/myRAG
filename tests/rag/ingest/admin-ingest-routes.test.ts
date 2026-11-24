import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';

const ADMIN_A = '00000000-0000-4000-8000-0000000000a1';
const ADMIN_B = '00000000-0000-4000-8000-0000000000b1';
const PLAIN_USER = '00000000-0000-4000-8000-0000000000f1';
const ORG_X = '00000000-0000-4000-8000-0000000000c1';
const ORG_Y = '00000000-0000-4000-8000-0000000000c2';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UNKNOWN_ID = id(999);
const SECRET_PATH = 'originals/secret-quartz-path.pdf';
const SECRET_STAGE = 'secret-stage-state-value';
const SECRET_SOURCE_KEY = 'secret-source-key-value';
const SECRET_LOCK = 'worker-secret-lock';
const SECRET_SHA = 'a'.repeat(64);
const SECRET_TRACE = 'trace-secret-value';
const DB_MESSAGE = 'duplicate key value violates constraint secret_db_detail';

const OPERATOR_KEYS = [
  'batch_id',
  'created_at',
  'doc_class',
  'document_id',
  'error_class',
  'est_cost_usd',
  'filename',
  'id',
  'kind',
  'max_retries',
  'mime_type',
  'needs_review_reason',
  'pages',
  'retries',
  'source',
  'stage',
  'status',
  'tenant_key',
  'tier',
  'updated_at',
];
const HIDDEN_KEYS = ['original_ref', 'settings', 'stage_state', 'source_key', 'file_sha256', 'locked_by', 'timings', 'trace_id'];

type Row = Record<string, unknown>;

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

const state = {
  mode: 'multi-tenant' as 'single-tenant' | 'multi-tenant',
  session: null as { id: string } | null,
  authThrows: false,
  lookupFails: false,
  admins: [] as string[],
  orgMembers: [] as Array<{ organization_id: string; user_id: string; role: string }>,
  jobs: [] as Row[],
  currentDocs: new Set<string>(),
  calls: [] as Call[],
  rpcFails: false,
  budgetRows: [] as Row[],
  overrides: [] as Row[],
};

function jobRow(n: number, tenantKey: string, overrides: Row = {}): Row {
  const settings = buildJobSettings({
    queueConfig: loadQueueConfig({}),
    profile: getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: loadRoutingConfig(),
  });
  return {
    id: id(n),
    kind: 'ingest',
    status: 'failed',
    tenant_key: tenantKey,
    source: 'config_upload',
    source_key: SECRET_SOURCE_KEY,
    priority: 100,
    retries: 1,
    max_retries: 3,
    escalations: 0,
    attempts: [],
    page_ranges: [],
    tier_page_counts: {},
    detect_counts: null,
    timings: { parse: 120 },
    stage_state: { note: SECRET_STAGE },
    settings,
    created_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 10, 1, 1, n)).toISOString(),
    deleted_at: null,
    lease_until: null,
    run_after: null,
    locked_by: SECRET_LOCK,
    runner: null,
    batch_id: null,
    document_id: null,
    lineage_id: null,
    version: null,
    file_sha256: SECRET_SHA,
    filename: `report-${n}.pdf`,
    mime_type: 'application/pdf',
    original_ref: { bucket: 'rag-originals', path: SECRET_PATH },
    stage: 'parse',
    doc_class: 'general',
    tier: 'fast',
    parser_used: null,
    parser_version: null,
    pages: 12,
    preflight_ref: null,
    est_cost_usd: 0.25,
    embedding_profile: null,
    error_class: 'parse_failed',
    needs_review_reason: null,
    routing_note: null,
    provisional_published_at: null,
    trace_id: SECRET_TRACE,
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

function adminTenantKeys(actor: string): string[] {
  if (state.mode === 'single-tenant') return ['s:default'];
  return [
    `u:${actor}`,
    ...state.orgMembers.filter((m) => m.user_id === actor && (m.role === 'owner' || m.role === 'admin')).map((m) => `o:${m.organization_id}`),
  ];
}

function live(): Row[] {
  return state.jobs.filter((job) => job.deleted_at === null);
}

function fakeDb(): RpcClient {
  return {
    rpc(fn, args) {
      const a = (args ?? {}) as Record<string, unknown>;
      state.calls.push({ fn, args: a });
      if (state.rpcFails) return respond(null, { code: 'XX000', message: DB_MESSAGE });
      if (fn === 'rag_list_ingestion_jobs') {
        const statuses = a.p_statuses as string[] | null;
        const rows = live()
          .filter((job) => a.p_tenant_key === null || job.tenant_key === a.p_tenant_key)
          .filter((job) => a.p_kind === null || job.kind === a.p_kind)
          .filter((job) => statuses === null || statuses.includes(job.status as string))
          .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(y.id).localeCompare(String(x.id)));
        const offset = (a.p_offset as number) ?? 0;
        const limit = (a.p_limit as number) ?? 50;
        return respond(rows.slice(offset, offset + limit).map((row) => ({ ...row })));
      }
      if (fn === 'rag_get_ingestion_job') {
        const row = live().find((job) => job.id === a.p_job_id && job.tenant_key === a.p_tenant_key);
        return respond(row ? [{ ...row }] : []);
      }
      if (fn === 'rag_retry_ingestion_job' || fn === 'rag_delete_ingestion_job') {
        const keys = adminTenantKeys(a.p_actor as string);
        const row = live().find((job) => job.id === a.p_job_id && keys.includes(job.tenant_key as string));
        if (!row) return respond(null, { code: '22023', message: 'ingest_refused: job_not_found' });
        if (fn === 'rag_retry_ingestion_job') {
          if (row.status !== 'failed' && row.status !== 'needs_review') {
            return respond(null, { code: '22023', message: 'ingest_refused: invalid_status_for_retry' });
          }
          row.status = 'queued';
          row.retries = 0;
          row.error_class = null;
          return respond([{ ...row }]);
        }
        if (typeof row.document_id === 'string' && state.currentDocs.has(row.document_id)) {
          return respond(null, { code: '22023', message: 'ingest_refused: document_is_current' });
        }
        row.deleted_at = '2026-11-24T12:00:00.000Z';
        return respond([{ ...row }]);
      }
      if (fn === 'rag_parse_budget_month') {
        return respond(state.budgetRows.filter((row) => a.p_tenant_key === null || row.tenant_key === a.p_tenant_key).map((row) => ({ ...row })));
      }
      if (fn === 'rag_get_parse_tier_overrides') return respond(state.overrides.map((row) => ({ ...row })));
      if (fn === 'rag_set_parse_tier_override') {
        const docType = a.p_doc_type as string;
        const min = a.p_min_tier as string | null;
        const max = a.p_max_tier as string | null;
        state.overrides = state.overrides.filter((row) => row.doc_type !== docType);
        if (min === null && max === null) return respond([]);
        const row = { doc_type: docType, min_tier: min, max_tier: max, updated_by: a.p_actor, updated_at: '2026-11-24T12:00:00.000Z' };
        state.overrides.push(row);
        return respond([{ ...row }]);
      }
      return respond([]);
    },
  };
}

function guardDb() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
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
            if (state.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
            return Promise.resolve({ data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
          }
          const member = state.orgMembers.find((m) => m.organization_id === filters.organization_id && m.user_id === filters.user_id);
          return Promise.resolve({ data: member ? { organization_id: member.organization_id } : null, error: null });
        },
      };
      return query;
    },
  };
}

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
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => guardDb(), supabaseAdmin: guardDb() }));
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ db: () => fakeDb() });
  const list = await import('@/app/api/rag/admin/ingest-jobs/route');
  const detail = await import('@/app/api/rag/admin/ingest-jobs/[id]/route');
  const retry = await import('@/app/api/rag/admin/ingest-jobs/[id]/retry/route');
  const budget = await import('@/app/api/rag/admin/parse-budget/route');
  const tiers = await import('@/app/api/rag/admin/parse-tiers/route');
  return { list, detail, retry, budget, tiers };
}

const ctx = (jobId: string) => ({ params: Promise.resolve({ id: jobId }) });
const req = (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

function asAdminA() {
  state.session = { id: ADMIN_A };
}

function ledgerCalls(): Call[] {
  return state.calls;
}

function callsOf(fn: string): Call[] {
  return state.calls.filter((call) => call.fn === fn);
}

const BASE = '/api/rag/admin/ingest-jobs';
let logged: string[] = [];

function resetState() {
  state.mode = 'multi-tenant';
  state.session = null;
  state.authThrows = false;
  state.lookupFails = false;
  state.admins = [ADMIN_A, ADMIN_B];
  state.orgMembers = [];
  state.jobs = [];
  state.currentDocs = new Set();
  state.calls = [];
  state.rpcFails = false;
  state.budgetRows = [];
  state.overrides = [];
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
  }
}

function cleanup() {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/deployment-mode');
  vi.unstubAllEnvs();
}

describe('admin ingest job routes', () => {
  beforeEach(resetState);
  afterEach(cleanup);

  describe('guard', () => {
    type Invoke = (routes: Awaited<ReturnType<typeof loadRoutes>>, headers: Record<string, string>) => Promise<Response>;
    const targets: Array<[string, Invoke]> = [
      ['GET list', (r, headers) => r.list.GET(req(BASE, { headers }))],
      ['GET detail', (r, headers) => r.detail.GET(req(`${BASE}/${id(1)}`, { headers }), ctx(id(1)))],
      ['POST retry', (r, headers) => r.retry.POST(req(`${BASE}/${id(1)}/retry`, { method: 'POST', headers }), ctx(id(1)))],
      ['DELETE detail', (r, headers) => r.detail.DELETE(req(`${BASE}/${id(1)}`, { method: 'DELETE', headers }), ctx(id(1)))],
    ];

    for (const [label, invoke] of targets) {
      describe(label, () => {
        beforeEach(() => {
          state.jobs = [jobRow(1, `u:${ADMIN_A}`)];
        });

        it('401 without a credential, before any ledger call', async () => {
          const routes = await loadRoutes();
          const response = await invoke(routes, {});
          expect(response.status).toBe(401);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(ledgerCalls()).toEqual([]);
        });

        it('403 for a signed-in user who is not an admin', async () => {
          state.session = { id: PLAIN_USER };
          const routes = await loadRoutes();
          const response = await invoke(routes, {});
          expect(response.status).toBe(403);
          expect(ledgerCalls()).toEqual([]);
        });

        it('503 when the session lookup throws', async () => {
          state.session = { id: ADMIN_A };
          state.authThrows = true;
          const routes = await loadRoutes();
          const response = await invoke(routes, {});
          expect(response.status).toBe(503);
          expect(ledgerCalls()).toEqual([]);
        });

        it('503 when the admin_users lookup fails', async () => {
          state.session = { id: ADMIN_A };
          state.lookupFails = true;
          const routes = await loadRoutes();
          const response = await invoke(routes, {});
          expect(response.status).toBe(503);
          expect(ledgerCalls()).toEqual([]);
        });

        it('401 for a forged admin_session cookie without a live session', async () => {
          const routes = await loadRoutes();
          const response = await invoke(routes, { cookie: `admin_session=${ADMIN_A}` });
          expect(response.status).toBe(401);
          expect(ledgerCalls()).toEqual([]);
        });

        it('a forged admin_session cookie does not lift a plain session', async () => {
          state.session = { id: PLAIN_USER };
          const routes = await loadRoutes();
          const response = await invoke(routes, { cookie: `admin_session=${ADMIN_A}` });
          expect(response.status).toBe(403);
          expect(ledgerCalls()).toEqual([]);
        });

        it('401 for the literal bearer admin', async () => {
          const routes = await loadRoutes();
          const response = await invoke(routes, { authorization: 'Bearer admin' });
          expect(response.status).toBe(401);
          expect(ledgerCalls()).toEqual([]);
        });
      });
    }
  });

  describe('GET list', () => {
    it('filters by status and kind, newest first, and pages with an opaque keyset cursor', async () => {
      asAdminA();
      const tenant = `u:${ADMIN_A}`;
      state.jobs = [
        jobRow(1, tenant, { status: 'failed' }),
        jobRow(2, tenant, { status: 'needs_review', needs_review_reason: 'low_confidence' }),
        jobRow(3, tenant, { status: 'ready' }),
        jobRow(4, tenant, { status: 'failed' }),
        jobRow(5, tenant, { status: 'failed', kind: 'dry_run' }),
        jobRow(6, tenant, { status: 'failed' }),
      ];
      const { list } = await loadRoutes();
      const first = await list.GET(req(`${BASE}?status=failed&status=needs_review&kind=ingest&limit=2`));
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const firstBody = await first.json();
      expect(firstBody.success).toBe(true);
      expect(firstBody.items.map((item: Row) => item.id)).toEqual([id(6), id(4)]);
      expect(typeof firstBody.next_cursor).toBe('string');

      const second = await list.GET(req(`${BASE}?status=failed&status=needs_review&kind=ingest&limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`));
      const secondBody = await second.json();
      expect(secondBody.items.map((item: Row) => item.id)).toEqual([id(2), id(1)]);
      expect(secondBody.next_cursor).toBeNull();
    });

    it('never repeats or skips a row when a newer job arrives between pages', async () => {
      asAdminA();
      const tenant = `u:${ADMIN_A}`;
      state.jobs = [jobRow(1, tenant), jobRow(2, tenant), jobRow(3, tenant)];
      const { list } = await loadRoutes();
      const first = await (await list.GET(req(`${BASE}?limit=2`))).json();
      expect(first.items.map((item: Row) => item.id)).toEqual([id(3), id(2)]);
      state.jobs.push(jobRow(9, tenant));
      const second = await (await list.GET(req(`${BASE}?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`))).json();
      expect(second.items.map((item: Row) => item.id)).toEqual([id(1)]);
    });

    it('400 for an unknown status, a bad kind, a bad limit and a forged cursor, without touching the ledger', async () => {
      asAdminA();
      const { list } = await loadRoutes();
      for (const query of ['status=exploded', 'kind=other', 'limit=0', 'limit=101', 'cursor=not-a-cursor', 'organizationId=nope']) {
        const response = await list.GET(req(`${BASE}?${query}`));
        expect(response.status, query).toBe(query.startsWith('organizationId') ? 403 : 400);
        const body = await response.json();
        expect(body.success).toBe(false);
        expect(typeof body.error).toBe('string');
      }
      expect(callsOf('rag_list_ingestion_jobs')).toEqual([]);
    });

    it('returns exactly the operator allow-list per row and none of the hidden fields', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`)];
      const { list } = await loadRoutes();
      const response = await list.GET(req(BASE));
      const text = await response.text();
      const body = JSON.parse(text);
      expect(body.items).toHaveLength(1);
      expect(Object.keys(body.items[0]).sort()).toEqual(OPERATOR_KEYS);
      for (const key of HIDDEN_KEYS) expect(Object.keys(body.items[0])).not.toContain(key);
      for (const secret of [SECRET_PATH, SECRET_STAGE, SECRET_SOURCE_KEY, SECRET_LOCK, SECRET_SHA, SECRET_TRACE]) {
        expect(text).not.toContain(secret);
      }
    });

    it('shows kind on every row: a dry_run job that ended ready is listed as dry_run', async () => {
      asAdminA();
      const tenant = `u:${ADMIN_A}`;
      state.jobs = [jobRow(1, tenant, { status: 'ready', kind: 'dry_run' }), jobRow(2, tenant, { status: 'ready', kind: 'ingest' })];
      const { list } = await loadRoutes();
      const body = await (await list.GET(req(`${BASE}?status=ready`))).json();
      const kinds = Object.fromEntries(body.items.map((item: Row) => [item.id, item.kind]));
      expect(kinds).toEqual({ [id(1)]: 'dry_run', [id(2)]: 'ingest' });
      const dry = await (await list.GET(req(`${BASE}?status=ready&kind=dry_run`))).json();
      expect(dry.items.map((item: Row) => item.id)).toEqual([id(1)]);
    });

    it('two tenants: admin A lists only tenant A jobs and the ledger is asked for tenant A only', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`), jobRow(2, `u:${ADMIN_B}`), jobRow(3, `o:${ORG_X}`), jobRow(4, 's:default')];
      const { list } = await loadRoutes();
      const body = await (await list.GET(req(BASE))).json();
      expect(body.items.map((item: Row) => item.id)).toEqual([id(1)]);
      expect(callsOf('rag_list_ingestion_jobs').every((call) => call.args.p_tenant_key === `u:${ADMIN_A}`)).toBe(true);
    });

    it('an organization workspace is honoured only after the membership check', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`), jobRow(2, `o:${ORG_X}`), jobRow(3, `o:${ORG_Y}`)];
      const { list } = await loadRoutes();

      const denied = await list.GET(req(`${BASE}?organizationId=${ORG_X}`));
      expect(denied.status).toBe(403);
      expect(callsOf('rag_list_ingestion_jobs')).toEqual([]);

      state.orgMembers = [{ organization_id: ORG_X, user_id: ADMIN_A, role: 'owner' }];
      const allowed = await (await list.GET(req(`${BASE}?organizationId=${ORG_X}`))).json();
      expect(allowed.items.map((item: Row) => item.id)).toEqual([id(2)]);
      expect(callsOf('rag_list_ingestion_jobs').at(-1)?.args.p_tenant_key).toBe(`o:${ORG_X}`);
    });

    it('single-tenant deployments list the default tenant', async () => {
      state.mode = 'single-tenant';
      asAdminA();
      state.jobs = [jobRow(1, 's:default'), jobRow(2, `u:${ADMIN_B}`)];
      const { list } = await loadRoutes();
      const body = await (await list.GET(req(BASE))).json();
      expect(body.items.map((item: Row) => item.id)).toEqual([id(1)]);
    });

    it('503 without echoing the database message when the ledger fails', async () => {
      asAdminA();
      state.rpcFails = true;
      const { list } = await loadRoutes();
      const response = await list.GET(req(BASE));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain('secret_db_detail');
      expect(logged.join('\n')).not.toContain('secret_db_detail');
    });
  });

  describe('GET detail', () => {
    it('returns the job with attempts and page_ranges but not original_ref, settings or stage_state', async () => {
      asAdminA();
      state.jobs = [
        jobRow(1, `u:${ADMIN_A}`, {
          attempts: [
            {
              attempt_no: 1,
              cache_hit: false,
              check: null,
              est_cost_usd: 0.1,
              ms: 900,
              pages: { start: 1, end: 12 },
              parser: 'docling',
              parser_version: '1',
              preset: 'fast',
              reason: 'initial',
              refused: false,
              tier: 'fast',
            },
          ],
          page_ranges: [
            { cache_id: null, end: 12, layer: 'L1', parser: 'docling', preset: 'fast', signals: [], start: 1, status: 'ok', tier: 'fast' },
          ],
        }),
      ];
      const { detail } = await loadRoutes();
      const response = await detail.GET(req(`${BASE}/${id(1)}`), ctx(id(1)));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      const body = JSON.parse(text);
      expect(body.success).toBe(true);
      expect(body.job.attempts).toHaveLength(1);
      expect(body.job.page_ranges).toHaveLength(1);
      expect(Object.keys(body.job).sort()).toEqual([...OPERATOR_KEYS, 'attempts', 'page_ranges'].sort());
      for (const secret of [SECRET_PATH, SECRET_STAGE, SECRET_SOURCE_KEY, SECRET_LOCK, SECRET_SHA, SECRET_TRACE]) {
        expect(text).not.toContain(secret);
      }
    });

    it('404 for an unknown id, and the same body for another tenant job', async () => {
      asAdminA();
      state.jobs = [jobRow(2, `u:${ADMIN_B}`), jobRow(3, `o:${ORG_X}`)];
      const { detail } = await loadRoutes();
      const unknown = await detail.GET(req(`${BASE}/${UNKNOWN_ID}`), ctx(UNKNOWN_ID));
      const foreignUser = await detail.GET(req(`${BASE}/${id(2)}`), ctx(id(2)));
      const foreignOrg = await detail.GET(req(`${BASE}/${id(3)}`), ctx(id(3)));
      expect(unknown.status).toBe(404);
      expect(foreignUser.status).toBe(404);
      expect(foreignOrg.status).toBe(404);
      const unknownBody = await unknown.json();
      expect(await foreignUser.json()).toEqual(unknownBody);
      expect(await foreignOrg.json()).toEqual(unknownBody);
    });

    it('400 for a non-UUID id without touching the ledger', async () => {
      asAdminA();
      const { detail } = await loadRoutes();
      const response = await detail.GET(req(`${BASE}/not-a-uuid`), ctx('not-a-uuid'));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(Array.isArray(body.details)).toBe(true);
      expect(ledgerCalls()).toEqual([]);
    });
  });

  describe('POST retry', () => {
    it('requeues a failed or needs_review job with the verified admin as actor, never a body field', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`, { status: 'failed' }), jobRow(2, `u:${ADMIN_A}`, { status: 'needs_review' })];
      const { retry } = await loadRoutes();
      const response = await retry.POST(req(`${BASE}/${id(1)}/retry`, { method: 'POST', body: { actor: ADMIN_B, p_actor: ADMIN_B } }), ctx(id(1)));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.job.id).toBe(id(1));
      expect(body.job.status).toBe('queued');
      expect(body.job.retries).toBe(0);
      expect(Object.keys(body.job).sort()).toEqual(OPERATOR_KEYS);
      expect(callsOf('rag_retry_ingestion_job')).toEqual([{ fn: 'rag_retry_ingestion_job', args: { p_job_id: id(1), p_actor: ADMIN_A } }]);

      const second = await retry.POST(req(`${BASE}/${id(2)}/retry`, { method: 'POST' }), ctx(id(2)));
      expect(second.status).toBe(200);
    });

    it('409 not_retryable for a ready job, with no retry call', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`, { status: 'ready' })];
      const { retry } = await loadRoutes();
      const response = await retry.POST(req(`${BASE}/${id(1)}/retry`, { method: 'POST' }), ctx(id(1)));
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('not_retryable');
      expect(callsOf('rag_retry_ingestion_job')).toEqual([]);
    });

    it('two tenants: admin A cannot retry tenant B job, which reads like an unknown id, and nothing is retried', async () => {
      asAdminA();
      state.jobs = [jobRow(2, `u:${ADMIN_B}`, { status: 'failed' })];
      const { retry } = await loadRoutes();
      const foreign = await retry.POST(req(`${BASE}/${id(2)}/retry`, { method: 'POST' }), ctx(id(2)));
      const unknown = await retry.POST(req(`${BASE}/${UNKNOWN_ID}/retry`, { method: 'POST' }), ctx(UNKNOWN_ID));
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await foreign.json()).toEqual(await unknown.json());
      expect(callsOf('rag_retry_ingestion_job')).toEqual([]);
      expect(state.jobs[0]?.status).toBe('failed');
    });

    it('a job of an organization the admin is not a member of is 404 and untouched', async () => {
      asAdminA();
      state.jobs = [jobRow(3, `o:${ORG_X}`, { status: 'failed' })];
      const { retry } = await loadRoutes();
      const response = await retry.POST(req(`${BASE}/${id(3)}/retry`, { method: 'POST' }), ctx(id(3)));
      expect(response.status).toBe(404);
      const viaOrg = await retry.POST(req(`${BASE}/${id(3)}/retry?organizationId=${ORG_X}`, { method: 'POST' }), ctx(id(3)));
      expect(viaOrg.status).toBe(403);
      expect(callsOf('rag_retry_ingestion_job')).toEqual([]);
    });

    it('400 for a non-UUID id and 503 when the ledger fails, without echoing the database message', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`)];
      const { retry } = await loadRoutes();
      const bad = await retry.POST(req(`${BASE}/zzz/retry`, { method: 'POST' }), ctx('zzz'));
      expect(bad.status).toBe(400);
      state.rpcFails = true;
      const down = await retry.POST(req(`${BASE}/${id(1)}/retry`, { method: 'POST' }), ctx(id(1)));
      expect(down.status).toBe(503);
      expect(await down.text()).not.toContain('secret_db_detail');
    });
  });

  describe('DELETE detail', () => {
    it('removes an unpublished version and returns the job with deleted_at, actor from the guard', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`, { document_id: id(501) })];
      const { detail } = await loadRoutes();
      const response = await detail.DELETE(req(`${BASE}/${id(1)}`, { method: 'DELETE' }), ctx(id(1)));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.job.id).toBe(id(1));
      expect(typeof body.job.deleted_at).toBe('string');
      expect(callsOf('rag_delete_ingestion_job')).toEqual([{ fn: 'rag_delete_ingestion_job', args: { p_job_id: id(1), p_actor: ADMIN_A } }]);
      const gone = await detail.GET(req(`${BASE}/${id(1)}`), ctx(id(1)));
      expect(gone.status).toBe(404);
    });

    it('409 when the version is current, and the job stays', async () => {
      asAdminA();
      state.jobs = [jobRow(1, `u:${ADMIN_A}`, { status: 'ready', document_id: id(501) })];
      state.currentDocs.add(id(501));
      const { detail } = await loadRoutes();
      const response = await detail.DELETE(req(`${BASE}/${id(1)}`, { method: 'DELETE' }), ctx(id(1)));
      expect(response.status).toBe(409);
      expect(state.jobs[0]?.deleted_at).toBeNull();
    });

    it('two tenants: admin A cannot delete tenant B job, which reads like an unknown id', async () => {
      asAdminA();
      state.jobs = [jobRow(2, `u:${ADMIN_B}`)];
      const { detail } = await loadRoutes();
      const foreign = await detail.DELETE(req(`${BASE}/${id(2)}`, { method: 'DELETE' }), ctx(id(2)));
      const unknown = await detail.DELETE(req(`${BASE}/${UNKNOWN_ID}`, { method: 'DELETE' }), ctx(UNKNOWN_ID));
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual(await unknown.json());
      expect(callsOf('rag_delete_ingestion_job')).toEqual([]);
      expect(state.jobs[0]?.deleted_at).toBeNull();
    });
  });
});

describe('admin parse budget and tier routes', () => {
  beforeEach(() => {
    resetState();
    vi.stubEnv('RAG_PARSE_PREMIUM_PAGE_BUDGET', '5000');
    vi.stubEnv('RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC', '150');
  });
  afterEach(cleanup);

  const BUDGET = '/api/rag/admin/parse-budget';
  const TIERS = '/api/rag/admin/parse-tiers';
  const DOC_TYPES = ['contract_legal', 'financial_report', 'general', 'invoice_receipt', 'product_technical', 'scanned_image'];

  describe('guard', () => {
    type Invoke = (routes: Awaited<ReturnType<typeof loadRoutes>>, headers: Record<string, string>) => Promise<Response>;
    const body = { docType: 'general', minTier: 'fast', maxTier: 'premium' };
    const targets: Array<[string, Invoke]> = [
      ['GET budget', (r, headers) => r.budget.GET(req(BUDGET, { headers }))],
      ['GET tiers', (r, headers) => r.tiers.GET(req(TIERS, { headers }))],
      ['PUT tiers', (r, headers) => r.tiers.PUT(req(TIERS, { method: 'PUT', headers, body }))],
    ];
    for (const [label, invoke] of targets) {
      describe(label, () => {
        const cases: Array<[string, () => void, Record<string, string>, number]> = [
          ['401 without a credential', () => {}, {}, 401],
          ['403 for a signed-in non-admin', () => (state.session = { id: PLAIN_USER }), {}, 403],
          ['503 when the session lookup throws', () => {
            state.session = { id: ADMIN_A };
            state.authThrows = true;
          }, {}, 503],
          ['503 when the admin_users lookup fails', () => {
            state.session = { id: ADMIN_A };
            state.lookupFails = true;
          }, {}, 503],
          ['401 for a forged admin_session cookie', () => {}, { cookie: `admin_session=${ADMIN_A}` }, 401],
          ['401 for the literal bearer admin', () => {}, { authorization: 'Bearer admin' }, 401],
        ];
        for (const [name, setup, headers, status] of cases) {
          it(name, async () => {
            setup();
            const routes = await loadRoutes();
            const response = await invoke(routes, headers);
            expect(response.status).toBe(status);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(state.calls).toEqual([]);
            expect(state.overrides).toEqual([]);
          });
        }
      });
    }
  });

  describe('GET parse-budget', () => {
    it('returns this month reserved, used and L3 pages for the admin tenant with the configured limits', async () => {
      asAdminA();
      state.budgetRows = [
        { tenant_key: `u:${ADMIN_A}`, month: '2026-11-01', pages_reserved: 12, pages_used: 340, vlm_pages_used: 7 },
        { tenant_key: `u:${ADMIN_B}`, month: '2026-11-01', pages_reserved: 99, pages_used: 999, vlm_pages_used: 99 },
      ];
      const { budget } = await loadRoutes();
      const response = await budget.GET(req(BUDGET));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(body).toEqual({
        success: true,
        month: '2026-11',
        budgetPages: 5000,
        maxPagesPerDoc: 150,
        tenants: [{ tenantKey: `u:${ADMIN_A}`, reserved: 12, used: 340, vlmUsed: 7 }],
      });
      expect(callsOf('rag_parse_budget_month')).toEqual([{ fn: 'rag_parse_budget_month', args: { p_tenant_key: `u:${ADMIN_A}` } }]);
    });

    it('shows a zero row for a tenant that has used nothing yet', async () => {
      asAdminA();
      const { budget } = await loadRoutes();
      const body = await (await budget.GET(req(BUDGET))).json();
      expect(body.tenants).toEqual([{ tenantKey: `u:${ADMIN_A}`, reserved: 0, used: 0, vlmUsed: 0 }]);
    });

    it('an organization workspace needs the membership check; another tenant is never read', async () => {
      asAdminA();
      state.budgetRows = [{ tenant_key: `o:${ORG_X}`, month: '2026-11-01', pages_reserved: 1, pages_used: 2, vlm_pages_used: 3 }];
      const { budget } = await loadRoutes();
      const denied = await budget.GET(req(`${BUDGET}?organizationId=${ORG_X}`));
      expect(denied.status).toBe(403);
      expect(callsOf('rag_parse_budget_month')).toEqual([]);
      state.orgMembers = [{ organization_id: ORG_X, user_id: ADMIN_A, role: 'admin' }];
      const allowed = await (await budget.GET(req(`${BUDGET}?organizationId=${ORG_X}`))).json();
      expect(allowed.tenants).toEqual([{ tenantKey: `o:${ORG_X}`, reserved: 1, used: 2, vlmUsed: 3 }]);
    });

    it('503 without echoing the database message', async () => {
      asAdminA();
      state.rpcFails = true;
      const { budget } = await loadRoutes();
      const response = await budget.GET(req(BUDGET));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('secret_db_detail');
    });
  });

  describe('GET parse-tiers', () => {
    it('lists every doc type with its profile bounds, its override and the effective bounds', async () => {
      asAdminA();
      state.overrides = [{ doc_type: 'general', min_tier: 'structured', max_tier: 'premium', updated_by: ADMIN_B, updated_at: '2026-11-20T10:00:00.000Z' }];
      const { tiers } = await loadRoutes();
      const response = await tiers.GET(req(TIERS));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.items.map((item: Row) => item.doc_type)).toEqual(DOC_TYPES);
      const general = body.items.find((item: Row) => item.doc_type === 'general');
      expect(general.profile).toEqual({ min_tier: 'fast', max_tier: 'premium' });
      expect(general.override).toMatchObject({ min_tier: 'structured', max_tier: 'premium' });
      expect(general.effective).toEqual({ min_tier: 'structured', max_tier: 'premium' });
      const invoice = body.items.find((item: Row) => item.doc_type === 'invoice_receipt');
      expect(invoice.override).toBeNull();
      expect(invoice.effective).toEqual(invoice.profile);
    });
  });

  describe('PUT parse-tiers', () => {
    const put = (routes: Awaited<ReturnType<typeof loadRoutes>>, body: unknown) => routes.tiers.PUT(req(TIERS, { method: 'PUT', body }));

    it('stores the override with the verified admin as actor and returns the new effective bounds', async () => {
      asAdminA();
      const routes = await loadRoutes();
      const response = await put(routes, { docType: 'general', minTier: 'structured', maxTier: 'premium' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.doc_type).toBe('general');
      expect(body.effective).toEqual({ min_tier: 'structured', max_tier: 'premium' });
      expect(callsOf('rag_set_parse_tier_override')).toEqual([
        { fn: 'rag_set_parse_tier_override', args: { p_doc_type: 'general', p_min_tier: 'structured', p_max_tier: 'premium', p_actor: ADMIN_A } },
      ]);
    });

    it('400 for min above max, and nothing is stored', async () => {
      asAdminA();
      const routes = await loadRoutes();
      const response = await put(routes, { docType: 'general', minTier: 'premium', maxTier: 'fast' });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(Array.isArray(body.details)).toBe(true);
      expect(callsOf('rag_set_parse_tier_override')).toEqual([]);
      expect(state.overrides).toEqual([]);
    });

    it('400 for an unknown tier or doc type, one null bound, an extra field such as actor, and a body that is not JSON', async () => {
      asAdminA();
      const routes = await loadRoutes();
      const bad: unknown[] = [
        { docType: 'general', minTier: 'ultra', maxTier: 'premium' },
        { docType: 'novel', minTier: 'fast', maxTier: 'premium' },
        { docType: 'general', minTier: null, maxTier: 'premium' },
        { docType: 'general', minTier: 'fast', maxTier: null },
        { docType: 'general', minTier: 'fast', maxTier: 'premium', actor: ADMIN_B },
        { docType: 'general' },
      ];
      for (const body of bad) {
        const response = await put(routes, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      const notJson = await routes.tiers.PUT(new NextRequest(`http://localhost${TIERS}`, { method: 'PUT', body: '{nope', headers: { 'content-type': 'application/json' } }));
      expect(notJson.status).toBe(400);
      expect(callsOf('rag_set_parse_tier_override')).toEqual([]);
    });

    it('both null clears the override and the effective bounds fall back to the profile', async () => {
      asAdminA();
      state.overrides = [{ doc_type: 'general', min_tier: 'structured', max_tier: 'premium', updated_by: ADMIN_B, updated_at: '2026-11-20T10:00:00.000Z' }];
      const routes = await loadRoutes();
      const response = await put(routes, { docType: 'general', minTier: null, maxTier: null });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.override).toBeNull();
      expect(body.effective).toEqual({ min_tier: 'fast', max_tier: 'premium' });
      expect(callsOf('rag_set_parse_tier_override')[0]?.args).toEqual({ p_doc_type: 'general', p_min_tier: null, p_max_tier: null, p_actor: ADMIN_A });
      expect(state.overrides).toEqual([]);
    });

    it('503 without echoing the database message', async () => {
      asAdminA();
      state.rpcFails = true;
      const routes = await loadRoutes();
      const response = await put(routes, { docType: 'general', minTier: 'fast', maxTier: 'premium' });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('secret_db_detail');
    });
  });
});
