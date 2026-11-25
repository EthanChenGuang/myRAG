import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { isTenantScope, scopeKey } from '@/lib/rag/tenant/scope';
import { originalName, safeContentType } from '../artifacts';
import { loadIngestConfig } from '../config';
import { getIngestDeps } from '../deps';
import { backfillEmbedProvider } from '../enqueue';
import { fileSha256 } from '../hash';
import { ORIGINALS_BUCKET, ORIGINALS_MAX_BYTES, getObjectStore } from '../object-store';
import { profileFor, type DocType } from '../profiles/load';
import { resolveDocType } from '../profiles/resolve-doc-type';
import { queueConfigFromProcessEnv, type QueueConfig } from '../queue-config';
import { loadRoutingConfig } from '../routing/config';
import { buildJobSettings } from '../routing/settings-snapshot';
import { effectiveTierBounds } from '../routing/tier-bounds';
import type { BackfillBatchRef, InventoryEntry } from './inventory';
import type { SourceItem } from './sources';

/** Every backfill job is an operator import of the tenant's own files; the ledger and the document rows record it as such. */
const BACKFILL_SOURCE = 'config_upload';
const ENQUEUE_CHUNK = 500;
const LIST_PAGE = 1_000;
const TERMINAL = new Set(['ready', 'failed', 'quarantined', 'needs_review', 'skipped_duplicate']);
/** Jobs whose staged original is no longer needed: a failed job can be retried and keeps it. */
const SETTLED = new Set(['ready', 'quarantined', 'needs_review', 'skipped_duplicate']);
const DEFAULT_MONITOR_INTERVAL_MS = 5_000;

/** An inventory entry the run can read: its file is opened again to stage it at enqueue. */
export type RunEntry = InventoryEntry & Pick<SourceItem, 'open'>;

export interface RunDeps {
  rpc?: RpcClient;
  signal: AbortSignal;
}

export interface EnqueueRunOptions extends RunDeps {
  /** The queue switches the job snapshots are built from. Defaults to the process environment. */
  snapshot?: () => QueueConfig;
  /** ingest for the run, dry_run for the sample of D-33 step 2. */
  kind?: 'ingest' | 'dry_run';
}

export interface EnqueueRunResult {
  /** New ledger rows. */
  enqueued: number;
  /** Entries the batch already had a job of this kind for (a repeated call). */
  existing: number;
  /** Entries left out, by reason code; their files changed or grew past the size limit after the inventory. */
  refused: Record<string, number>;
}

export interface BatchProgress {
  spentUsd: number;
  /** Jobs whose lease has not expired. */
  leased: number;
  /** Job counts by kind, then by status. */
  counts: Record<string, Record<string, number>>;
}

export interface MonitorOptions extends RunDeps {
  intervalMs?: number;
  /** Gives up after this long and returns the last progress. */
  timeoutMs?: number;
  onProgress?: (progress: BatchProgress) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface EndReportFailure {
  sourceKey: string;
  errorClass: string | null;
  deadLetter: boolean;
}

export interface EndReportReview {
  sourceKey: string;
  documentId: string | null;
  reason: string | null;
}

export interface BackfillEndReport {
  batchId: string;
  /** Ingest jobs only: the counts that reconcile with the inventory. */
  ingest: { total: number; byStatus: Record<string, number> };
  /** The sample's dry_run jobs, kept out of every ingest count. */
  sample: { total: number; byStatus: Record<string, number> };
  failures: EndReportFailure[];
  needsReview: EndReportReview[];
  cost: {
    /** projected_cost.total_usd of the stored dry-run report, null when there is none. */
    projectedUsd: number | null;
    /** The parse cost the worker recorded on the batch's jobs, sample included (its premium pages count against the budget). */
    actualUsd: number;
    /** The budget reservations charged to the batch. */
    spentUsd: number;
    /** actual minus projected, null without a projection. */
    differenceUsd: number | null;
  };
}

interface BatchRow {
  id: string;
  tenantKey: string;
  spentUsd: number;
  dryRunReport: Record<string, unknown>;
}

type JobRow = Record<string, unknown>;

function rpcOf(deps: RunDeps): RpcClient {
  const rpc = deps.rpc ?? getIngestDeps().db();
  if (!rpc) throw new Error('[Backfill] admin client unavailable');
  return rpc;
}

function numberOf(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { data, error } = await rpc.rpc(fn, args).abortSignal(signal);
  if (error) throw new Error(`[Backfill] ${fn} failed`);
  return data;
}

/** The batch row. A no-op update is the one existing RPC that returns it (the inventory reads it the same way); it touches updated_at only. */
async function readBatch(rpc: RpcClient, batchId: string, signal: AbortSignal): Promise<BatchRow> {
  const data = await call(rpc, 'rag_update_ingestion_batch', { p_batch_id: batchId }, signal);
  const row = (Array.isArray(data) ? data[0] : data) as JobRow | null | undefined;
  const tenantKey = textOf(row?.tenant_key);
  if (!row || !tenantKey) throw new Error('[Backfill] batch lookup failed');
  const report = row.dry_run_report;
  return {
    id: batchId,
    tenantKey,
    spentUsd: numberOf(row.spent_usd),
    dryRunReport: report && typeof report === 'object' && !Array.isArray(report) ? (report as Record<string, unknown>) : {},
  };
}

/** The batch row must belong to the scope's tenant: the enqueue function takes the tenant from the row, so a mismatch is refused. */
async function checkedBatch(batch: BackfillBatchRef, rpc: RpcClient, signal: AbortSignal): Promise<BatchRow> {
  if (!isTenantScope(batch.scope)) throw new Error('[Backfill] batch tenant mismatch');
  const row = await readBatch(rpc, batch.id, signal);
  if (scopeKey(batch.scope).toLowerCase() !== row.tenantKey) {
    console.warn('[Backfill] batch tenant mismatch');
    throw new Error('[Backfill] batch tenant mismatch');
  }
  return row;
}

async function* batchJobs(rpc: RpcClient, batchId: string, signal: AbortSignal): AsyncGenerator<JobRow> {
  let after: string | null = null;
  for (;;) {
    const data = await call(rpc, 'rag_list_batch_jobs', { p_batch_id: batchId, p_status: null, p_after_id: after, p_limit: LIST_PAGE }, signal);
    const rows = (Array.isArray(data) ? data : []) as JobRow[];
    for (const row of rows) yield row;
    if (rows.length < LIST_PAGE) return;
    after = textOf(rows[rows.length - 1]?.id);
    if (!after) return;
  }
}

/** The staging key of a batch file: under the tenant's own prefix, one folder per file hash (the inventory keeps one file per hash). */
export function stagedOriginalKey(tenantKey: string, batchId: string, entry: Pick<InventoryEntry, 'fileSha256' | 'filename'>): string {
  return `${tenantKey}/backfill/${batchId.toLowerCase()}/${entry.fileSha256}/${originalName(entry.filename)}`;
}

function stagingPrefix(tenantKey: string, batchId: string): string {
  return `${tenantKey}/backfill/${batchId.toLowerCase()}/`;
}

async function readAll(entry: RunEntry, signal: AbortSignal): Promise<Uint8Array | 'too_large'> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of await entry.open(signal)) {
    const buffer = typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part as Uint8Array);
    size += buffer.byteLength;
    if (size > ORIGINALS_MAX_BYTES) return 'too_large';
    parts.push(buffer);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * D-33 step 4 (and the sample of step 2 with kind dry_run): stages each file in the private originals bucket under the batch
 * tenant's prefix and enqueues one job per entry at priority 10 with the batch id and a backfill snapshot (never progressive; Batch
 * API embeddings only when RAG_EMBED_BATCH_MODE asks for them). No document row is created: a job gets its version when the worker
 * first claims it (advance phase begin, D-31). Re-entrant: entries the batch already has a job of this kind for are skipped before
 * any upload, and the ledger's unique (batch_id, kind, source_key) drops a row that raced in (D-34). Nothing here activates an
 * embedding profile (D-36).
 */
export async function enqueueRun(batch: BackfillBatchRef, entries: readonly RunEntry[], options: EnqueueRunOptions): Promise<EnqueueRunResult> {
  const { signal } = options;
  const rpc = rpcOf(options);
  const row = await checkedBatch(batch, rpc, signal);
  const kind = options.kind ?? 'ingest';

  const existingKeys = new Set<string>();
  for await (const job of batchJobs(rpc, batch.id, signal)) {
    if (job.kind === kind && typeof job.source_key === 'string') existingKeys.add(job.source_key);
  }

  const queueConfig = (options.snapshot ?? queueConfigFromProcessEnv)();
  const deps = getIngestDeps();
  const ingestConfig = loadIngestConfig(deps.ingestEnv());
  const routingConfig = loadRoutingConfig();
  const embedProfileProvider = await backfillEmbedProvider();
  const settingsByType = new Map<DocType, ReturnType<typeof buildJobSettings>>();
  const settingsFor = async (docType: DocType) => {
    let settings = settingsByType.get(docType);
    if (!settings) {
      settings = buildJobSettings({
        queueConfig,
        profile: profileFor(BACKFILL_SOURCE, docType),
        bounds: await effectiveTierBounds(docType),
        routingConfig,
        kind,
        isBackfill: true,
        embedProfileProvider,
      });
      settingsByType.set(docType, settings);
    }
    return settings;
  };

  const store = getObjectStore();
  const refused: Record<string, number> = {};
  const refuse = (reason: string) => {
    refused[reason] = (refused[reason] ?? 0) + 1;
    console.warn('[Backfill] entry refused at enqueue', { reason });
  };
  const jobs: Record<string, unknown>[] = [];
  let existing = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    if (existingKeys.has(entry.sourceKey)) {
      existing += 1;
      continue;
    }
    const key = stagedOriginalKey(row.tenantKey, batch.id, entry);
    if (!(await store.exists(key, { signal }))) {
      const bytes = await readAll(entry, signal);
      if (bytes === 'too_large') {
        refuse('file_too_large');
        continue;
      }
      if (fileSha256(bytes) !== entry.fileSha256) {
        refuse('source_changed');
        continue;
      }
      await store.put(key, bytes, { contentType: safeContentType(entry.mimeType), signal });
    }
    const resolved = await resolveDocType(
      batch.scope,
      { ...(entry.docType ? { picked: entry.docType } : {}), source: BACKFILL_SOURCE, filename: entry.filename, mimeType: entry.mimeType },
      { db: deps.db, config: ingestConfig, signal },
    );
    jobs.push({
      kind,
      source: BACKFILL_SOURCE,
      source_key: entry.sourceKey,
      file_sha256: entry.fileSha256,
      filename: entry.filename,
      mime_type: entry.mimeType,
      original_ref: { bucket: ORIGINALS_BUCKET, path: key },
      settings: await settingsFor(resolved.docType),
    });
  }

  let enqueued = 0;
  for (let i = 0; i < jobs.length; i += ENQUEUE_CHUNK) {
    const data = await call(rpc, 'rag_enqueue_backfill_jobs', { p_batch_id: batch.id, p_jobs: jobs.slice(i, i + ENQUEUE_CHUNK) }, signal);
    enqueued += numberOf(Array.isArray(data) ? Object.values((data[0] ?? {}) as Record<string, unknown>)[0] : data);
  }
  console.log('[Backfill] run enqueued', { kind, enqueued, existing, refused: Object.values(refused).reduce((sum, n) => sum + n, 0) });
  return { enqueued, existing, refused };
}

function progressOf(data: unknown): BatchProgress {
  const raw = (Array.isArray(data) ? Object.values((data[0] ?? {}) as Record<string, unknown>)[0] : data) as JobRow | null;
  const counts: Record<string, Record<string, number>> = {};
  const rawCounts = raw?.counts;
  if (rawCounts && typeof rawCounts === 'object') {
    for (const [kind, byStatus] of Object.entries(rawCounts as Record<string, unknown>)) {
      if (!byStatus || typeof byStatus !== 'object') continue;
      counts[kind] = {};
      for (const [status, n] of Object.entries(byStatus as Record<string, unknown>)) counts[kind][status] = numberOf(n);
    }
  }
  return { spentUsd: numberOf(raw?.spent_usd), leased: numberOf(raw?.leased), counts };
}

export async function batchProgress(batchId: string, deps: RunDeps): Promise<BatchProgress> {
  return progressOf(await call(rpcOf(deps), 'rag_batch_progress', { p_batch_id: batchId }, deps.signal));
}

/** Jobs that are not terminal: queued, leased, or leased by a worker that died and waiting for the lease to expire. */
export function openJobs(progress: BatchProgress): number {
  let open = 0;
  for (const byStatus of Object.values(progress.counts)) {
    for (const [status, n] of Object.entries(byStatus)) if (!TERMINAL.has(status)) open += n;
  }
  return open;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * D-33 step 5 and D-34: polls the batch's progress until no job is queued or leased. A job held by a worker that was killed stays
 * open until its lease expires and a worker reclaims it, so monitoring simply continues across the restart.
 */
export async function monitor(batch: BackfillBatchRef, options: MonitorOptions): Promise<BatchProgress> {
  const { signal } = options;
  const rpc = rpcOf(options);
  await checkedBatch(batch, rpc, signal);
  const interval = Math.max(10, options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS);
  const sleep = options.sleep ?? defaultSleep;
  const started = Date.now();
  for (;;) {
    const progress = await batchProgress(batch.id, { rpc, signal });
    options.onProgress?.(progress);
    if (openJobs(progress) === 0) return progress;
    if (options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs) return progress;
    await sleep(interval, signal);
  }
}

function projectedTotal(report: Record<string, unknown>): number | null {
  const cost = report.projected_cost;
  if (!cost || typeof cost !== 'object') return null;
  const total = (cost as Record<string, unknown>).total_usd;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/**
 * D-33 step 5: the outcome of the batch. Ingest counts and the sample's dry_run counts are kept apart, so the ingest counts reconcile
 * with the inventory (ready + needs_review + skipped_duplicate + failed + quarantined = inventory total less unreadable files). Lists
 * every failure with its error class and every needs_review document with its reason, and the actual against the projected cost.
 */
export async function endReport(batch: BackfillBatchRef, deps: RunDeps): Promise<BackfillEndReport> {
  const { signal } = deps;
  const rpc = rpcOf(deps);
  const row = await checkedBatch(batch, rpc, signal);
  const ingest = { total: 0, byStatus: {} as Record<string, number> };
  const sample = { total: 0, byStatus: {} as Record<string, number> };
  const failures: EndReportFailure[] = [];
  const needsReview: EndReportReview[] = [];
  let actualUsd = 0;
  for await (const job of batchJobs(rpc, batch.id, signal)) {
    const status = String(job.status);
    actualUsd += numberOf(job.est_cost_usd);
    const bucket = job.kind === 'dry_run' ? sample : job.kind === 'ingest' ? ingest : null;
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byStatus[status] = (bucket.byStatus[status] ?? 0) + 1;
    if (job.kind !== 'ingest') continue;
    const sourceKey = String(job.source_key);
    if (status === 'failed') failures.push({ sourceKey, errorClass: textOf(job.error_class), deadLetter: job.dead_letter_at != null });
    if (status === 'needs_review') needsReview.push({ sourceKey, documentId: textOf(job.document_id), reason: textOf(job.needs_review_reason) });
  }
  const projectedUsd = projectedTotal(row.dryRunReport);
  const actual = Math.round(actualUsd * 1e6) / 1e6;
  return {
    batchId: batch.id,
    ingest,
    sample,
    failures,
    needsReview,
    cost: {
      projectedUsd,
      actualUsd: actual,
      spentUsd: row.spentUsd,
      differenceUsd: projectedUsd === null ? null : Math.round((actual - projectedUsd) * 1e6) / 1e6,
    },
  };
}

/**
 * Removes the staged originals no job of the batch needs any more: every job that points at one has settled (a failed job keeps its
 * file so it can be retried). Each version keeps its own copy, stored by begin. Returns the number of objects removed.
 */
export async function releaseStagedOriginals(batch: BackfillBatchRef, deps: RunDeps): Promise<number> {
  const { signal } = deps;
  const rpc = rpcOf(deps);
  const row = await checkedBatch(batch, rpc, signal);
  const prefix = stagingPrefix(row.tenantKey, batch.id);
  const settledByKey = new Map<string, boolean>();
  for await (const job of batchJobs(rpc, batch.id, signal)) {
    const ref = job.original_ref as { bucket?: unknown; path?: unknown } | null;
    if (!ref || ref.bucket !== ORIGINALS_BUCKET || typeof ref.path !== 'string' || !ref.path.startsWith(prefix)) continue;
    const settled = SETTLED.has(String(job.status));
    settledByKey.set(ref.path, (settledByKey.get(ref.path) ?? true) && settled);
  }
  const store = getObjectStore();
  let removed = 0;
  for (const [key, settled] of settledByKey) {
    if (!settled) continue;
    await store.remove(key, { signal });
    removed += 1;
  }
  return removed;
}
