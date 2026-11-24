import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JobSettingsSnapshotSchema } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import {
  IngestLedgerError,
  enqueueJob,
  getJobForScope,
  getJobInternal,
  resetLedgerDepsForTests,
} from '@/lib/rag/ingest/ledger';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { scopeFromIngestionJob as scopeFromJob } from '@/lib/rag/tenant/ingestion-job';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_O = '00000000-0000-4000-8000-0000000000c1';
const JOB_ID = '10000000-0000-4000-8000-000000000001';

function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => RpcResponse>): RpcClient {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const result = handlers[fn]?.(args) ?? { data: [], error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  (client as unknown as { calls: typeof calls }).calls = calls;
  return client;
}

function validJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings = buildJobSettings({
    queueConfig: loadQueueConfig({}),
    profile: getProcessingProfile('general'),
    bounds: { min_tier: 'fast', max_tier: 'premium' },
    routingConfig: loadRoutingConfig(),
  });
  return {
    id: JOB_ID,
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

beforeEach(() => {
  resetLedgerDepsForTests();
});

afterEach(() => {
  resetLedgerDepsForTests();
});

describe('enqueueJob', () => {
  test('sends p_tenant_key from the scope and the settings snapshot', async () => {
    const scope = mintScope('personal', USER_A, null);
    const settings = JobSettingsSnapshotSchema.parse(
      buildJobSettings({
        queueConfig: loadQueueConfig({}),
        profile: getProcessingProfile('general'),
        bounds: { min_tier: 'fast', max_tier: 'premium' },
        routingConfig: loadRoutingConfig(),
      }),
    );
    const rpc = fakeRpc({
      rag_enqueue_ingestion_job: (args) => {
        expect(args.p_tenant_key).toBe(scopeKey(scope));
        expect(args.p_settings).toEqual(settings);
        return { data: [validJobRow({ settings })], error: null };
      },
    });
    const signal = new AbortController().signal;
    const job = await enqueueJob(
      scope,
      { source: 'config_upload', sourceKey: 'doc.md', settings },
      { signal, deps: { db: () => rpc } },
    );
    expect(job.id).toBe(JOB_ID);
  });

  test('invalid_row throws without echoing row content', async () => {
    const scope = mintScope('personal', USER_A, null);
    const settings = buildJobSettings({
      queueConfig: loadQueueConfig({}),
      profile: getProcessingProfile('general'),
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig: loadRoutingConfig(),
    });
    const rpc = fakeRpc({
      rag_enqueue_ingestion_job: () => ({
        data: [validJobRow({ source_key: 123 })],
        error: null,
      }),
    });
    await expect(
      enqueueJob(scope, { source: 'config_upload', sourceKey: 'x', settings }, { signal: new AbortController().signal, deps: { db: () => rpc } }),
    ).rejects.toMatchObject({ name: 'IngestLedgerError', code: 'invalid_row', message: expect.not.stringContaining('source_key') });
  });

  test('SQLSTATE 55000 lease_lost maps to lease_lost', async () => {
    const scope = mintScope('personal', USER_A, null);
    const settings = buildJobSettings({
      queueConfig: loadQueueConfig({}),
      profile: getProcessingProfile('general'),
      bounds: { min_tier: 'fast', max_tier: 'premium' },
      routingConfig: loadRoutingConfig(),
    });
    const rpc = fakeRpc({
      rag_advance_ingestion_job: () => ({
        data: null,
        error: { code: '55000', message: 'lease_lost: worker mismatch secret-row-data' },
      }),
    });
    const { advanceJob } = await import('@/lib/rag/ingest/ledger');
    await expect(
      advanceJob(
        { jobId: JOB_ID, worker: 'w', stage: 'chunk', status: 'chunking' },
        { signal: new AbortController().signal, deps: { db: () => rpc } },
      ),
    ).rejects.toMatchObject({ code: 'lease_lost', message: expect.not.stringContaining('secret-row-data') });
  });
});

describe('getJobForScope', () => {
  test('returns null when the job belongs to another tenant', async () => {
    const scope = mintScope('personal', USER_A, null);
    const rpc = fakeRpc({
      rag_get_ingestion_job: (args) => {
        expect(args.p_tenant_key).toBe(scopeKey(scope));
        return { data: [], error: null };
      },
    });
    const job = await getJobForScope(scope, JOB_ID, { signal: new AbortController().signal, deps: { db: () => rpc } });
    expect(job).toBeNull();
  });
});

describe('scopeFromIngestionJob', () => {
  test('mints personal, org and single scopes from tenant keys only', async () => {
    const signal = new AbortController().signal;
    const db = fakeRpc({
      rag_get_ingestion_job_internal: (args) => {
        if (args.p_job_id === 'u-job') return { data: [validJobRow({ tenant_key: `u:${USER_A}` })], error: null };
        if (args.p_job_id === 'o-job') return { data: [validJobRow({ tenant_key: `o:${ORG_O}` })], error: null };
        if (args.p_job_id === 's-job') return { data: [validJobRow({ tenant_key: 's:default' })], error: null };
        return { data: [], error: null };
      },
    });

    const personal = await scopeFromJob('u-job', { db: () => db, signal, deploymentMode: 'multi-tenant' });
    expect(scopeKey(personal!)).toBe(`u:${USER_A}`);

    const org = await scopeFromJob('o-job', { db: () => db, signal, deploymentMode: 'multi-tenant' });
    expect(scopeKey(org!)).toBe(`o:${ORG_O}`);

    const single = await scopeFromJob('s-job', { db: () => db, signal, deploymentMode: 'single-tenant' });
    expect(scopeKey(single!)).toBe('s:default');
  });

  test('unknown job returns null and logs a reason code only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = fakeRpc({
      rag_get_ingestion_job_internal: () => ({ data: [], error: null }),
    });
    const scope = await scopeFromJob('missing', { db: () => db, signal: new AbortController().signal });
    expect(scope).toBeNull();
    expect(warn.mock.calls[0]?.[1]).toEqual({ reason: 'job_not_found' });
    warn.mockRestore();
  });

  test('s:default in multi-tenant mode is refused', async () => {
    const db = fakeRpc({
      rag_get_ingestion_job_internal: () => ({ data: [validJobRow({ tenant_key: 's:default' })], error: null }),
    });
    await expect(
      scopeFromJob('s-job', { db: () => db, signal: new AbortController().signal, deploymentMode: 'multi-tenant' }),
    ).rejects.toThrow('single tenant key in multi-tenant mode');
  });
});

// Boundary: re-export scopeFromIngestionJob must not be here — it lives under tenant/
describe('IngestLedgerError', () => {
  test('carries rpc name and code without row payload', () => {
    const error = new IngestLedgerError('rag_enqueue_ingestion_job', 'invalid_row');
    expect(error.rpc).toBe('rag_enqueue_ingestion_job');
    expect(error.code).toBe('invalid_row');
    expect(error.message).not.toContain('{');
  });
});