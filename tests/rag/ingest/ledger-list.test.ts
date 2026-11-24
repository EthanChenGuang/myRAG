import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import * as rag from '@/lib/rag';
import { listJobs, listJobsAllTenants, listJobsPage, resetLedgerDepsForTests } from '@/lib/rag/ingest/ledger';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const SECRET = 'secret-file-name-must-not-be-logged.pdf';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings = buildJobSettings({
    queueConfig: loadQueueConfig({}),
    profile: getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: loadRoutingConfig(),
  });
  return {
    id: id(n),
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
    lease_until: null,
    run_after: null,
    locked_by: null,
    runner: null,
    batch_id: null,
    document_id: null,
    lineage_id: null,
    version: null,
    file_sha256: null,
    filename: null,
    mime_type: null,
    original_ref: null,
    stage: null,
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

function db(rows: unknown[]): { client: RpcClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client: RpcClient = {
    rpc(_fn, args) {
      calls.push(args as Record<string, unknown>);
      const result: RpcResponse = { data: rows as never, error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}

const signal = new AbortController().signal;
const scope = mintScope('personal', USER_A, null);
let logged: string[] = [];

beforeEach(() => {
  resetLedgerDepsForTests();
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLedgerDepsForTests();
});

describe('listJobs needs a tenant scope (MEDIUM-7)', () => {
  test('an unscoped call from the public API is refused before the database is asked', async () => {
    const { client, calls } = db([row(1)]);
    await expect(listJobs({ statuses: null } as never, { signal, deps: { db: () => client } })).rejects.toThrow();
    await expect(listJobs({ scope: null, statuses: null } as never, { signal, deps: { db: () => client } })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('a scoped call sends that tenant key', async () => {
    const { client, calls } = db([row(1)]);
    const jobs = await listJobs({ scope }, { signal, deps: { db: () => client } });
    expect(jobs).toHaveLength(1);
    expect(calls[0]?.p_tenant_key).toBe(scopeKey(scope));
  });

  test('the all-tenant listing is a separate internal function and not part of the public index', async () => {
    const { client, calls } = db([row(1)]);
    await listJobsAllTenants({ statuses: ['failed'] }, { signal, deps: { db: () => client } });
    expect(calls[0]?.p_tenant_key).toBeNull();
    expect('listJobsAllTenants' in rag).toBe(false);
    expect('listJobs' in rag).toBe(true);
  });
});

describe('a malformed row does not fail the list (LOW-3)', () => {
  test('it is skipped and counted, and the log carries no row content', async () => {
    const { client } = db([row(1), row(2, { source_key: 123, filename: SECRET }), row(3)]);
    const page = await listJobsPage({ scope }, { signal, deps: { db: () => client } });
    expect(page.jobs.map((job) => job.id)).toEqual([id(1), id(3)]);
    expect(page.fetched).toBe(3);
    expect(page.skipped).toBe(1);
    const text = logged.join('\n');
    expect(text).toContain('[Ingest]');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(id(2));
  });

  test('listJobs returns the valid rows', async () => {
    const { client } = db([row(1, { source_key: 123 }), row(2)]);
    const jobs = await listJobs({ scope }, { signal, deps: { db: () => client } });
    expect(jobs.map((job) => job.id)).toEqual([id(2)]);
  });

  test('no skipped rows means no log line', async () => {
    const { client } = db([row(1)]);
    await listJobsPage({ scope }, { signal, deps: { db: () => client } });
    expect(logged).toEqual([]);
  });
});
