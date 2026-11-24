import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { SIDECAR_SECRET_HEADER } from '@/lib/rag/ingest/callbacks/internal-auth';
import { installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';

const SECRET = 'queued-route-sidecar-secret-00000000000';
const OPTIONS_HASH = 'd'.repeat(64);
const JOB_A = '10000000-0000-4000-8000-000000000001';
const JOB_UNKNOWN = '20000000-0000-4000-8000-000000000002';
const DOC_TENANT_B = '30000000-0000-4000-8000-000000000003';
const WORKER_A = 'worker-holding-lease-a';
const WORKER_B = 'worker-other-tenant-b';
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000c2';
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

const ROUTES = [
  { action: 'parse-external' as const, loader: () => import('@/app/api/internal/rag/ingest/jobs/[id]/parse-external/route') },
  { action: 'advance' as const, loader: () => import('@/app/api/internal/rag/ingest/jobs/[id]/advance/route') },
];

type LedgerCall = { fn: string; args: Record<string, unknown> };

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings = buildJobSettings({
    queueConfig: loadQueueConfig({}),
    profile: getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: loadRoutingConfig(),
  });
  return {
    id: JOB_A,
    kind: 'ingest',
    status: 'queued',
    tenant_key: `u:${USER_A}`,
    source: 'config_upload',
    source_key: 'doc.md',
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
    settings,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    document_id: DOC_TENANT_B,
    lineage_id: null,
    version: null,
    lease_until: new Date(NOW + 60_000).toISOString(),
    run_after: null,
    locked_by: WORKER_A,
    runner: 'worker',
    batch_id: null,
    file_sha256: null,
    filename: 'ledger-filename.pdf',
    mime_type: 'application/pdf',
    original_ref: null,
    stage: 'parse',
    doc_class: null,
    tier: null,
    parser_used: null,
    parser_version: null,
    pages: null,
    preflight_ref: null,
    est_cost_usd: null,
    embedding_profile: null,
    error_class: null,
    needs_review_reason: null,
    routing_note: null,
    provisional_published_at: null,
    trace_id: null,
    ...overrides,
  };
}

function fakeLedger(handlers: Record<string, (args: Record<string, unknown>) => RpcResponse>): { db: RpcClient; calls: LedgerCall[] } {
  const calls: LedgerCall[] = [];
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      const result = handlers[fn]?.((args ?? {}) as Record<string, unknown>) ?? { data: [], error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { db, calls };
}

function parseBody(worker: string, extra: Record<string, unknown> = {}) {
  return {
    worker_id: worker,
    attempt_no: 1,
    mode: 'chain',
    options_hash: OPTIONS_HASH,
    continuation: null,
    cursor: null,
    pages: null,
    subpdf_ref: null,
    ...extra,
  };
}

function advanceBody(worker: string, cacheId: string, extra: Record<string, unknown> = {}) {
  return {
    worker_id: worker,
    attempt_no: 1,
    phase: 'post_parse',
    parse_cache_id: cacheId,
    deadline_ms: 40_000,
    cursor: null,
    ...extra,
  };
}

async function post(
  action: 'parse-external' | 'advance',
  jobId: string,
  body: unknown,
  secret: string | null | undefined,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null && secret !== undefined) headers[SIDECAR_SECRET_HEADER] = secret;
  const loader = ROUTES.find((route) => route.action === action)!.loader;
  const route = await loader();
  const req = new NextRequest(`http://localhost/api/internal/rag/ingest/jobs/${jobId}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const res = await route.POST(req, { params: Promise.resolve({ id: jobId }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
}

beforeEach(() => {
  process.env.RAG_SIDECAR_SECRET = SECRET;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  installIngestDeps({
    db: fakeLedger({
      rag_get_ingestion_job_internal: (args) => {
        if (args.p_job_id === JOB_UNKNOWN) return { data: [], error: null };
        if (args.p_job_id === JOB_A) return { data: [jobRow()], error: null };
        return { data: [], error: null };
      },
    }).db,
    now: () => NOW,
  });
});

afterEach(() => {
  uninstallIngestDeps();
  vi.restoreAllMocks();
  delete process.env.RAG_SIDECAR_SECRET;
});

describe.each(ROUTES.map((route) => [route.action] as const))('internal ingest %s route', (action) => {
  const body =
    action === 'parse-external'
      ? parseBody(WORKER_A)
      : advanceBody(WORKER_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  it('returns 401 { error: unauthorized } when the secret is unset and never calls the ledger', async () => {
    delete process.env.RAG_SIDECAR_SECRET;
    const ledger = fakeLedger({});
    installIngestDeps({ db: ledger.db, now: () => NOW });
    const res = await post(action, JOB_A, body, SECRET);
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'unauthorized' });
    expect(ledger.calls).toHaveLength(0);
  });

  it('returns 401 for a missing, wrong or last-character-different secret without ledger calls', async () => {
    const ledger = fakeLedger({});
    installIngestDeps({ db: ledger.db, now: () => NOW });
    for (const secret of [undefined, '', 'not-the-secret', SECRET.slice(0, -1)]) {
      const res = await post(action, JOB_A, body, secret);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized' });
    }
    expect(ledger.calls).toHaveLength(0);
  });

  it('returns 400 for a non-UUID job id before the ledger runs', async () => {
    const ledger = fakeLedger({});
    installIngestDeps({ db: ledger.db, now: () => NOW });
    const res = await post(action, 'abc', body, SECRET);
    expect(res.status).toBe(400);
    expect(ledger.calls).toHaveLength(0);
  });

  it('returns 404 for an unknown job id', async () => {
    const res = await post(action, JOB_UNKNOWN, body, SECRET);
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'job_not_found' });
  });

  it('returns 409 lease_lost when the worker does not hold the lease', async () => {
    const workerBody =
      action === 'parse-external' ? parseBody(WORKER_B) : advanceBody(WORKER_B, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const res = await post(action, JOB_A, workerBody, SECRET);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'lease_lost' });
  });

  it('returns 400 when the body carries tenant_key (extra=forbid)', async () => {
    const ledger = fakeLedger({});
    installIngestDeps({ db: ledger.db, now: () => NOW });
    const scoped =
      action === 'parse-external'
        ? parseBody(WORKER_A, { tenant_key: `o:${ORG_B}` })
        : advanceBody(WORKER_A, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { tenant_key: `o:${ORG_B}` });
    const res = await post(action, JOB_A, scoped, SECRET);
    expect(res.status).toBe(400);
    expect(ledger.calls).toHaveLength(0);
  });
});

describe('tenant scope minted only from the job row', () => {
  it('never passes another tenant document id into scope or writer RPC arguments', async () => {
    const { db, calls } = fakeLedger({
      rag_get_ingestion_job_internal: (args) =>
        args.p_job_id === JOB_A ? { data: [jobRow({ document_id: DOC_TENANT_B })], error: null } : { data: [], error: null },
    });
    installIngestDeps({ db, now: () => NOW });
    const scopeModule = await import('@/lib/rag/tenant/ingestion-job');
    const scopeSpy = vi.spyOn(scopeModule, 'scopeFromIngestionJob');
    const crossBody = parseBody(WORKER_A, { document_id: DOC_TENANT_B, organization_id: ORG_B });
    const res = await post('parse-external', JOB_A, crossBody, SECRET);
    expect(res.status).toBe(400);
    expect(scopeSpy).not.toHaveBeenCalled();
    expect(calls.every((call) => call.args.p_tenant_key !== `o:${ORG_B}`)).toBe(true);
    scopeSpy.mockRestore();
  });
});

describe('callback errors stay opaque', () => {
  it('returns no stack trace, filename or document text and logs only [RAG Ingest] with an error name', async () => {
    const { db } = fakeLedger({
      rag_get_ingestion_job_internal: () => {
        throw new Error('sensitive stack at ledger-filename.pdf\n    at /secret/path.ts:1:1');
      },
    });
    installIngestDeps({ db, now: () => NOW });
    const errorSpy = vi.spyOn(console, 'error');
    const res = await post('parse-external', JOB_A, parseBody(WORKER_A), SECRET);
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/ledger-filename|\/secret\/path|sensitive stack/);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('[RAG Ingest]');
    expect(logged).not.toMatch(/ledger-filename|\/secret\/path|sensitive stack/);
  });
});