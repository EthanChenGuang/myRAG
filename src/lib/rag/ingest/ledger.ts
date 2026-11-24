import type { RpcClient } from '../backend/supabase-rpc';
import { IngestionJobSchema, type IngestionJob, type JobSettingsSnapshot } from '@/lib/rag-eval/contracts.generated';
import { getIngestDeps } from './deps';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';

type Row = Record<string, unknown>;

const LEASE_LOST = /^lease_lost\b/;

/** Stable ledger failure codes; messages never carry row content (D-04). */
export class IngestLedgerError extends Error {
  readonly rpc: string;
  readonly code: string | null;

  constructor(rpc: string, code: string | null) {
    super(`[Ingest Ledger] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'IngestLedgerError';
    this.rpc = rpc;
    this.code = code;
  }
}

export interface LedgerDeps {
  db: () => RpcClient | null;
}

const ledgerDefaults: LedgerDeps = {
  db: () => getIngestDeps().db(),
};

let ledgerOverrides: Partial<LedgerDeps> = {};

export function getLedgerDeps(): LedgerDeps {
  return { ...ledgerDefaults, ...ledgerOverrides };
}

export function setLedgerDepsForTests(partial: Partial<LedgerDeps>): void {
  ledgerOverrides = { ...ledgerOverrides, ...partial };
}

export function resetLedgerDepsForTests(): void {
  ledgerOverrides = {};
}

export interface LedgerCallOptions {
  signal: AbortSignal;
  deps?: LedgerDeps;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function ledgerCode(rpc: string, sqlCode: string | null | undefined, message: string | undefined): string | null {
  const code = sqlCode ?? null;
  if (code === '55000' && LEASE_LOST.test(message ?? '')) return 'lease_lost';
  if (code === '22023') {
    const word = /^[a-z_]+/.exec(message ?? '')?.[0];
    return word ?? code;
  }
  return code;
}

const STRIPPED_JOB_COLUMNS = new Set(['error']);

function normalizeJobRow(row: Row): Row {
  const out: Row = { ...row };
  for (const key of STRIPPED_JOB_COLUMNS) delete out[key];
  for (const key of ['created_at', 'updated_at', 'deleted_at', 'lease_until', 'run_after', 'provisional_published_at'] as const) {
    const value = iso(out[key]);
    if (value !== null) out[key] = value;
  }
  if (out.attempts === undefined) out.attempts = [];
  if (out.page_ranges === undefined) out.page_ranges = [];
  if (out.tier_page_counts === undefined) out.tier_page_counts = {};
  if (out.detect_counts === undefined) out.detect_counts = null;
  if (
    out.detect_counts &&
    typeof out.detect_counts === 'object' &&
    !Array.isArray(out.detect_counts) &&
    Object.keys(out.detect_counts as object).length === 0
  ) {
    out.detect_counts = null;
  }
  if (out.timings === undefined) out.timings = {};
  if (out.stage_state === undefined) out.stage_state = {};
  if (typeof out.est_cost_usd === 'string') out.est_cost_usd = Number(out.est_cost_usd);
  if (out.settings && typeof out.settings === 'object') {
    out.settings = out.settings;
  }
  return out;
}

function parseJobRow(rpc: string, row: Row): IngestionJob {
  const parsed = IngestionJobSchema.safeParse(normalizeJobRow(row));
  if (!parsed.success) throw new IngestLedgerError(rpc, 'invalid_row');
  return parsed.data;
}

async function callRpc(
  rpc: string,
  args: Record<string, unknown>,
  options: LedgerCallOptions,
): Promise<Row[]> {
  const deps = options.deps ?? getLedgerDeps();
  const db = deps.db();
  if (!db) throw new IngestLedgerError(rpc, 'no_db');
  options.signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(options.signal);
  options.signal.throwIfAborted();
  if (response.error) {
    throw new IngestLedgerError(rpc, ledgerCode(rpc, response.error.code, response.error.message));
  }
  return normalizeRpcRows(rpc, response.data);
}

/**
 * PostgREST answers a SETOF function with an array and any other function with one JSON value: an object for a composite, a bare
 * scalar for an int, null for no row. An all-null composite (no id) counts as no row.
 */
function normalizeRpcRows(rpc: string, data: unknown): Row[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data.filter((row): row is Row => !!row && typeof row === 'object' && (row as Row).id !== null);
  if (typeof data === 'object') return (data as Row).id === null ? [] : [data as Row];
  return [{ [rpc]: data }];
}

async function callOne(rpc: string, args: Record<string, unknown>, options: LedgerCallOptions): Promise<Row> {
  const rows = await callRpc(rpc, args, options);
  const row = rows[0];
  if (!row) throw new IngestLedgerError(rpc, 'no_row');
  return row;
}

export interface EnqueueJobArgs {
  kind?: 'ingest' | 'dry_run' | 'delete';
  source: string;
  sourceKey: string;
  fileSha256?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  originalRef?: Record<string, unknown> | null;
  settings: JobSettingsSnapshot;
  priority?: number;
  documentId?: string | null;
  batchId?: string | null;
  status?: IngestionJob['status'];
}

export async function enqueueJob(
  scope: TenantScope,
  args: EnqueueJobArgs,
  options: LedgerCallOptions,
): Promise<IngestionJob> {
  assertTenantScope(scope);
  const row = await callOne(
    'rag_enqueue_ingestion_job',
    {
      p_tenant_key: scopeKey(scope).toLowerCase(),
      p_kind: args.kind ?? 'ingest',
      p_source: args.source,
      p_source_key: args.sourceKey,
      p_file_sha256: args.fileSha256 ?? null,
      p_filename: args.filename ?? null,
      p_mime_type: args.mimeType ?? null,
      p_original_ref: args.originalRef ?? null,
      p_settings: args.settings,
      p_priority: args.priority ?? 100,
      p_document_id: args.documentId ?? null,
      p_batch_id: args.batchId ?? null,
      p_status: args.status ?? 'queued',
    },
    options,
  );
  return parseJobRow('rag_enqueue_ingestion_job', row);
}

export interface AdvanceJobArgs {
  jobId: string;
  worker: string;
  stage: string;
  status: string;
  stageState?: Record<string, unknown> | null;
  timingMs?: number | null;
  fields?: Record<string, unknown>;
}

export async function advanceJob(args: AdvanceJobArgs, options: LedgerCallOptions): Promise<IngestionJob> {
  const row = await callOne(
    'rag_advance_ingestion_job',
    {
      p_job_id: args.jobId,
      p_worker: args.worker,
      p_stage: args.stage,
      p_status: args.status,
      p_stage_state: args.stageState ?? null,
      p_timing_ms: args.timingMs ?? null,
      p_fields: args.fields ?? {},
    },
    options,
  );
  return parseJobRow('rag_advance_ingestion_job', row);
}

export async function recordAttempt(
  jobId: string,
  worker: string,
  attempt: Record<string, unknown>,
  options: LedgerCallOptions,
): Promise<number> {
  const rows = await callRpc(
    'rag_record_parse_attempt',
    { p_job_id: jobId, p_worker: worker, p_attempt: attempt },
    options,
  );
  const value = rows[0]?.rag_record_parse_attempt ?? rows[0];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const first = Object.values(rows[0] ?? {})[0];
  if (typeof first === 'number' && Number.isInteger(first)) return first;
  throw new IngestLedgerError('rag_record_parse_attempt', 'bad_response');
}

export async function failJob(
  jobId: string,
  worker: string,
  errorClass: string,
  retryable: boolean,
  options: LedgerCallOptions,
): Promise<IngestionJob> {
  const row = await callOne(
    'rag_fail_ingestion_job',
    { p_job_id: jobId, p_worker: worker, p_error_class: errorClass, p_retryable: retryable },
    options,
  );
  return parseJobRow('rag_fail_ingestion_job', row);
}

export async function retryJob(jobId: string, actorId: string, options: LedgerCallOptions): Promise<IngestionJob> {
  const row = await callOne('rag_retry_ingestion_job', { p_job_id: jobId, p_actor: actorId }, options);
  return parseJobRow('rag_retry_ingestion_job', row);
}

export async function deleteJob(jobId: string, actorId: string, options: LedgerCallOptions): Promise<IngestionJob> {
  const row = await callOne('rag_delete_ingestion_job', { p_job_id: jobId, p_actor: actorId }, options);
  return parseJobRow('rag_delete_ingestion_job', row);
}

export async function getJobForScope(
  scope: TenantScope,
  jobId: string,
  options: LedgerCallOptions,
): Promise<IngestionJob | null> {
  assertTenantScope(scope);
  const rows = await callRpc(
    'rag_get_ingestion_job',
    { p_job_id: jobId, p_tenant_key: scopeKey(scope).toLowerCase() },
    options,
  );
  const row = rows[0];
  if (!row?.id) return null;
  return parseJobRow('rag_get_ingestion_job', row);
}

export async function getJobForDocument(
  scope: TenantScope,
  documentId: string,
  options: LedgerCallOptions,
): Promise<IngestionJob | null> {
  assertTenantScope(scope);
  const rows = await callRpc(
    'rag_get_job_for_document',
    { p_document_id: documentId, p_tenant_key: scopeKey(scope).toLowerCase() },
    options,
  );
  const row = rows[0];
  if (!row?.id) return null;
  return parseJobRow('rag_get_job_for_document', row);
}

export async function getJobInternal(jobId: string, options: LedgerCallOptions): Promise<IngestionJob | null> {
  const rows = await callRpc('rag_get_ingestion_job_internal', { p_job_id: jobId }, options);
  const row = rows[0];
  if (!row?.id) return null;
  return parseJobRow('rag_get_ingestion_job_internal', row);
}

export interface ListJobsArgs {
  scope?: TenantScope | null;
  statuses?: string[] | null;
  kind?: string | null;
  limit?: number;
  offset?: number;
}

export async function listJobs(args: ListJobsArgs, options: LedgerCallOptions): Promise<IngestionJob[]> {
  if (args.scope) assertTenantScope(args.scope);
  const tenantKey = args.scope ? scopeKey(args.scope).toLowerCase() : null;
  const rows = await callRpc(
    'rag_list_ingestion_jobs',
    {
      p_tenant_key: tenantKey,
      p_statuses: args.statuses ?? null,
      p_kind: args.kind ?? null,
      p_limit: args.limit ?? 50,
      p_offset: args.offset ?? 0,
    },
    options,
  );
  return rows.filter((row) => row?.id).map((row) => parseJobRow('rag_list_ingestion_jobs', row));
}