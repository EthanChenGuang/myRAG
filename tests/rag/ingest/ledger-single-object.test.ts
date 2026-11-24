import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { JobSettingsSnapshotSchema } from '@/lib/rag-eval/contracts.generated';
import {
  advanceJob,
  deleteJob,
  enqueueJob,
  failJob,
  getJobForDocument,
  getJobForScope,
  getJobInternal,
  recordAttempt,
  resetLedgerDepsForTests,
  retryJob,
} from '@/lib/rag/ingest/ledger';
import { buildJobSettings } from '@/lib/rag/ingest/routing/settings-snapshot';
import { loadQueueConfig } from '@/lib/rag/ingest/queue-config';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { getProcessingProfile } from '@/lib/rag/ingest/profiles/load';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const JOB_ID = '10000000-0000-4000-8000-000000000001';

/**
 * PostgREST answers a non-SETOF function with one JSON value (an object, a scalar or null) and a SETOF function with an array.
 * `postgrestAnswer` reproduces that so a single-row RPC test cannot pass on the array shape alone.
 */
function postgrestAnswer(rows: unknown[], setof: boolean): unknown {
  if (setof) return rows;
  return rows[0] ?? null;
}

function fakeRpc(fn: string, data: unknown): RpcClient {
  return {
    rpc(name) {
      const result: RpcResponse = name === fn ? { data: data as never, error: null } : { data: null, error: { code: 'P0001', message: 'unexpected' } };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

const scope = mintScope('personal', USER_A, null);
const settings = JobSettingsSnapshotSchema.parse(jobRow().settings);

function opts(fn: string, data: unknown) {
  return { signal: new AbortController().signal, deps: { db: () => fakeRpc(fn, data) } };
}

beforeEach(() => resetLedgerDepsForTests());
afterEach(() => resetLedgerDepsForTests());

describe('single-row ledger RPCs accept the PostgREST object answer', () => {
  test('the fake models PostgREST: a non-SETOF function answers the first row, SETOF the array', () => {
    expect(postgrestAnswer([{ id: 1 }], false)).toEqual({ id: 1 });
    expect(postgrestAnswer([], false)).toBeNull();
    expect(postgrestAnswer([{ id: 1 }], true)).toEqual([{ id: 1 }]);
  });

  test('enqueueJob', async () => {
    const data = postgrestAnswer([jobRow({ settings })], false);
    const job = await enqueueJob(scope, { source: 'config_upload', sourceKey: 'doc.md', settings }, opts('rag_enqueue_ingestion_job', data));
    expect(job.id).toBe(JOB_ID);
  });

  test('advanceJob', async () => {
    const data = postgrestAnswer([jobRow({ status: 'chunking' })], false);
    const job = await advanceJob({ jobId: JOB_ID, worker: 'w', stage: 'chunk', status: 'chunking' }, opts('rag_advance_ingestion_job', data));
    expect(job.status).toBe('chunking');
  });

  test('failJob', async () => {
    const data = postgrestAnswer([jobRow({ status: 'failed' })], false);
    const job = await failJob(JOB_ID, 'w', 'parse_error', false, opts('rag_fail_ingestion_job', data));
    expect(job.status).toBe('failed');
  });

  test('retryJob', async () => {
    const data = postgrestAnswer([jobRow()], false);
    const job = await retryJob(JOB_ID, USER_A, opts('rag_retry_ingestion_job', data));
    expect(job.id).toBe(JOB_ID);
  });

  test('deleteJob', async () => {
    const data = postgrestAnswer([jobRow({ deleted_at: '2026-01-02T00:00:00.000Z' })], false);
    const job = await deleteJob(JOB_ID, USER_A, opts('rag_delete_ingestion_job', data));
    expect(job.id).toBe(JOB_ID);
  });

  test('getJobForScope returns the job for an object and null for null or an all-null composite', async () => {
    expect((await getJobForScope(scope, JOB_ID, opts('rag_get_ingestion_job', postgrestAnswer([jobRow()], false))))?.id).toBe(JOB_ID);
    expect(await getJobForScope(scope, JOB_ID, opts('rag_get_ingestion_job', null))).toBeNull();
    expect(await getJobForScope(scope, JOB_ID, opts('rag_get_ingestion_job', { id: null, tenant_key: null }))).toBeNull();
  });

  test('getJobForDocument', async () => {
    const data = postgrestAnswer([jobRow()], false);
    expect((await getJobForDocument(scope, JOB_ID, opts('rag_get_job_for_document', data)))?.id).toBe(JOB_ID);
    expect(await getJobForDocument(scope, JOB_ID, opts('rag_get_job_for_document', null))).toBeNull();
  });

  test('getJobInternal', async () => {
    const data = postgrestAnswer([jobRow()], false);
    expect((await getJobInternal(JOB_ID, opts('rag_get_ingestion_job_internal', data)))?.id).toBe(JOB_ID);
    expect(await getJobInternal(JOB_ID, opts('rag_get_ingestion_job_internal', null))).toBeNull();
  });

  test('recordAttempt reads the bare integer PostgREST answers', async () => {
    expect(await recordAttempt(JOB_ID, 'w', {}, opts('rag_record_parse_attempt', 3))).toBe(3);
    expect(await recordAttempt(JOB_ID, 'w', {}, opts('rag_record_parse_attempt', [{ rag_record_parse_attempt: 4 }]))).toBe(4);
  });

  test('the array shape still works', async () => {
    const job = await retryJob(JOB_ID, USER_A, opts('rag_retry_ingestion_job', [jobRow()]));
    expect(job.id).toBe(JOB_ID);
  });

  test('a null answer for a write RPC is no_row', async () => {
    await expect(retryJob(JOB_ID, USER_A, opts('rag_retry_ingestion_job', null))).rejects.toMatchObject({ code: 'no_row' });
  });
});
