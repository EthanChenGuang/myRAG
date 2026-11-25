import path from 'node:path';
import type { BackfillDryRunReport } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { getRagDeps } from '../../deps';
import { getIngestDeps } from '../deps';
import { resolveEmbeddingTargets } from '../embedding-targets';
import { queueConfigFromProcessEnv, type QueueConfig } from '../queue-config';
import { loadRoutingConfig } from '../routing/config';
import { inventory, type BackfillBatchRef } from './inventory';
import { buildReport, embeddingLowerBoundUsd, formatReport, sampleJobFromRow, type ProjectionProfile, type ProjectionSnapshot, type SampleJob } from './report';
import { endReport, enqueueRun, monitor, releaseStagedOriginals, type BackfillEndReport, type BatchProgress, type RunEntry } from './run';
import { startRunner as defaultStartRunner, type RunnerHandle, type RunnerIo, type RunnerName } from './runners';
import { selectSample } from './sample';
import { listSource, type BackfillSourceDeps, type BackfillStorageBucket, type SourceItem, type SourceKind } from './sources';

export const EXIT = { ok: 0, failed: 1, reportOnly: 2, overBudget: 3, usage: 64 } as const;

export interface BackfillRequest {
  scope: TenantScope;
  /** Required for a new batch; on resume the batch's own source is used and a given one must match it. */
  source: { kind: SourceKind; ref: string } | null;
  /** Manifest sources only: the directory every manifest path must resolve under. */
  root: string | null;
  budgetUsd: number | null;
  concurrency: number;
  dryRun: boolean;
  resumeBatchId: string | null;
  runner: RunnerName;
}

export interface OrchestrateDeps {
  rpc?: RpcClient;
  signal: AbortSignal;
  io: RunnerIo;
  sourceDeps?: BackfillSourceDeps;
  /** The queue switches the run's job snapshots are built from. Defaults to the process environment. */
  snapshot?: () => QueueConfig;
  /** The embedding profiles the projection prices. Defaults to the profiles a new chunk is written for (P3 D-39). */
  profiles?: () => Promise<ProjectionProfile[]>;
  startRunner?: (runner: RunnerName, batchId: string) => RunnerHandle;
  monitorIntervalMs?: number;
  monitorTimeoutMs?: number;
}

export interface BackfillOutcome {
  exitCode: number;
  batchId: string | null;
  report: BackfillDryRunReport | null;
  end: BackfillEndReport | null;
}

/** A refusal the operator can fix by changing the command line (exit 64). */
export class BackfillUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillUsageError';
  }
}

interface BatchRow {
  id: string;
  tenantKey: string;
  sourceKind: SourceKind;
  sourceRef: string;
  budgetUsd: number | null;
  spentUsd: number;
  concurrency: number;
  runner: RunnerName;
  status: string;
}

type JobRow = Record<string, unknown>;

const MAX_SAMPLE_ROUNDS = 10;
const DEFAULT_MONITOR_INTERVAL_MS = 2_000;
const LIST_PAGE = 1_000;
const MAX_LISTED = 50;
const STATUS_ORDER = ['ready', 'skipped_duplicate', 'needs_review', 'failed', 'quarantined'];

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number): string {
  return value.toFixed(6);
}

function rpcOf(deps: Pick<OrchestrateDeps, 'rpc'>): RpcClient {
  const rpc = deps.rpc ?? getIngestDeps().db();
  if (!rpc) throw new Error('[Backfill] admin client unavailable');
  return rpc;
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { data, error } = await rpc.rpc(fn, args).abortSignal(signal);
  if (error) throw new Error(`[Backfill] ${fn} failed${error.message ? `: ${error.message.slice(0, 200)}` : ''}`);
  return data;
}

function batchRowOf(data: unknown): BatchRow {
  const row = (Array.isArray(data) ? data[0] : data) as JobRow | null | undefined;
  if (!row || typeof row.id !== 'string' || typeof row.tenant_key !== 'string') throw new Error('[Backfill] batch lookup failed');
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    sourceKind: row.source_kind as SourceKind,
    sourceRef: String(row.source_ref),
    budgetUsd: numberOf(row.budget_usd),
    spentUsd: numberOf(row.spent_usd) ?? 0,
    concurrency: numberOf(row.concurrency) ?? 1,
    runner: row.runner === 'ray' ? 'ray' : 'worker',
    status: String(row.status),
  };
}

/** The batch row, read and optionally updated through the one RPC that returns it. */
async function updateBatch(
  rpc: RpcClient,
  batchId: string,
  signal: AbortSignal,
  fields: { status?: string; report?: BackfillDryRunReport; totals?: Record<string, unknown> } = {},
): Promise<BatchRow> {
  return batchRowOf(
    await call(
      rpc,
      'rag_update_ingestion_batch',
      {
        p_batch_id: batchId,
        ...(fields.status ? { p_status: fields.status } : {}),
        ...(fields.report ? { p_dry_run_report: fields.report } : {}),
        ...(fields.totals ? { p_totals: fields.totals } : {}),
      },
      signal,
    ),
  );
}

async function listJobs(rpc: RpcClient, batchId: string, signal: AbortSignal): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  let after: string | null = null;
  for (;;) {
    const data = await call(rpc, 'rag_list_batch_jobs', { p_batch_id: batchId, p_status: null, p_after_id: after, p_limit: LIST_PAGE }, signal);
    const page = (Array.isArray(data) ? data : []) as JobRow[];
    rows.push(...page);
    if (page.length < LIST_PAGE) return rows;
    const last = page[page.length - 1]?.id;
    if (typeof last !== 'string') return rows;
    after = last;
  }
}

/** The profiles a new chunk is embedded for: the active one, backfilling ones and the previous one. Reading only; nothing is activated. */
export async function projectionProfiles(): Promise<ProjectionProfile[]> {
  const targets = await resolveEmbeddingTargets({ findBackfillRuns: async () => [] });
  return targets.map((target) => ({ id: target.profile.id, provider: target.profile.provider }));
}

function normalisedRef(kind: SourceKind, ref: string): string {
  return kind === 'bucket' ? ref.trim() : path.resolve(ref);
}

function defaultSourceDeps(): BackfillSourceDeps {
  const admin = getRagDeps().adminClient();
  if (!admin) return {};
  return { storage: { from: (bucket: string) => admin.storage.from(bucket) as unknown as BackfillStorageBucket } };
}

function progressLine(progress: BatchProgress): string {
  const parts = Object.entries(progress.counts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, byStatus]) => `${kind === 'dry_run' ? 'sample' : kind} ${statusList(byStatus)}`);
  return `[Backfill] progress: ${parts.join('; ') || 'no jobs'}; leased ${progress.leased}; reserved ${money(progress.spentUsd)} USD`;
}

function statusList(byStatus: Record<string, number>): string {
  const names = Object.keys(byStatus).sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a);
    const ib = STATUS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  });
  return names.map((name) => `${name} ${byStatus[name]}`).join(', ') || 'none';
}

/** The end report's ingest and sample sections as they are stored on the batch row: every count comes from ingest jobs only. */
export function batchTotals(end: BackfillEndReport): Record<string, unknown> {
  const of = (status: string) => end.ingest.byStatus[status] ?? 0;
  return {
    ingest_total: end.ingest.total,
    ready: of('ready'),
    skipped_duplicate: of('skipped_duplicate'),
    needs_review: of('needs_review'),
    failed: of('failed'),
    quarantined: of('quarantined'),
    ingest: { total: end.ingest.total, by_status: end.ingest.byStatus },
    sample: { total: end.sample.total, by_status: end.sample.byStatus },
    cost: {
      projected_usd: end.cost.projectedUsd,
      actual_usd: end.cost.actualUsd,
      spent_usd: end.cost.spentUsd,
      difference_usd: end.cost.differenceUsd,
    },
  };
}

/** D-33 step 5, printed. Ingest counts and the sample's dry runs are separate sections, so a dry run never reads as ingested. */
export function formatEndReport(end: BackfillEndReport): string[] {
  const lines = [
    `[Backfill] end report for batch ${end.batchId}`,
    `[Backfill] ingest jobs ${end.ingest.total}: ${statusList(end.ingest.byStatus)}`,
    `[Backfill] sample (dry runs, not ingested) ${end.sample.total}: ${statusList(end.sample.byStatus)}`,
  ];
  for (const failure of end.failures.slice(0, MAX_LISTED)) {
    lines.push(`[Backfill] failed: ${failure.sourceKey} (${failure.errorClass ?? 'unknown'}${failure.deadLetter ? ', dead letter' : ''})`);
  }
  if (end.failures.length > MAX_LISTED) lines.push(`[Backfill] failed: and ${end.failures.length - MAX_LISTED} more`);
  for (const review of end.needsReview.slice(0, MAX_LISTED)) {
    lines.push(`[Backfill] needs_review: ${review.sourceKey} (${review.reason ?? 'no reason recorded'})`);
  }
  if (end.needsReview.length > MAX_LISTED) lines.push(`[Backfill] needs_review: and ${end.needsReview.length - MAX_LISTED} more`);
  const cost = end.cost;
  lines.push(
    `[Backfill] cost: actual ${money(cost.actualUsd)} USD, projected ${cost.projectedUsd === null ? 'none' : `${money(cost.projectedUsd)} USD`}, difference ${
      cost.differenceUsd === null ? 'none' : `${money(cost.differenceUsd)} USD`
    }, reserved ${money(cost.spentUsd)} USD`,
  );
  return lines;
}

/** End report, batch totals (ingest jobs only, the sample apart), staged originals released, status completed. */
export async function finishBatch(batch: BackfillBatchRef, deps: Pick<OrchestrateDeps, 'rpc' | 'signal' | 'io'>): Promise<BackfillEndReport> {
  const rpc = rpcOf(deps);
  const end = await endReport(batch, { rpc, signal: deps.signal });
  const released = await releaseStagedOriginals(batch, { rpc, signal: deps.signal });
  await updateBatch(rpc, batch.id, deps.signal, { status: 'completed', totals: batchTotals(end) });
  for (const line of formatEndReport(end)) deps.io.out(line);
  if (released > 0) deps.io.out(`[Backfill] released ${released} staged originals`);
  return end;
}

interface RunContext {
  rpc: RpcClient;
  batch: BackfillBatchRef;
  deps: OrchestrateDeps;
  runner: RunnerName;
}

/** Monitors the batch until no job is open, with the runner started for it; a Ray runner that exits with an error stops the wait. */
async function runAndMonitor(ctx: RunContext): Promise<BatchProgress> {
  const { deps, batch } = ctx;
  const start = deps.startRunner ?? ((runner: RunnerName, batchId: string) => defaultStartRunner(runner, batchId, { io: deps.io }));
  const handle = start(ctx.runner, batch.id);
  const controller = new AbortController();
  const forward = () => controller.abort(deps.signal.reason);
  deps.signal.addEventListener('abort', forward, { once: true });
  let runnerFailed = false;
  void handle.done.then(({ exitCode }) => {
    if (exitCode !== 0) {
      runnerFailed = true;
      controller.abort(new Error('runner_failed'));
    }
  });
  let last = '';
  try {
    return await monitor(batch, {
      rpc: ctx.rpc,
      signal: controller.signal,
      intervalMs: deps.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS,
      ...(deps.monitorTimeoutMs !== undefined ? { timeoutMs: deps.monitorTimeoutMs } : {}),
      onProgress: (progress) => {
        const line = progressLine(progress);
        if (line !== last) deps.io.out(line);
        last = line;
      },
    });
  } catch (error) {
    if (runnerFailed && !deps.signal.aborted) throw new Error(`[Backfill] the ${ctx.runner} runner exited with an error`);
    throw error;
  } finally {
    deps.signal.removeEventListener('abort', forward);
    handle.stop();
  }
}

function sampleQueueConfig(config: QueueConfig): QueueConfig {
  // Dry runs need per-page tiers, which only tiered routing produces (the worker refuses a fixed dry run).
  return { ...config, parseRouting: 'tiered' };
}

/**
 * D-33 step 2: enqueue the sample as dry_run jobs, wait for them, learn the class preflight gave each file and grow the sample until
 * every class has 20 files or the 5% cap is reached. Re-entrant: a resumed batch draws the same sample (seeded by the batch id) and
 * finds its jobs already in the ledger.
 */
async function runSample(ctx: RunContext, entries: RunEntry[], config: QueueConfig): Promise<SampleJob[]> {
  const { rpc, batch, deps } = ctx;
  const byKey = new Map(entries.map((entry) => [entry.sourceKey, entry] as const));
  const classes = new Map<string, string | null>();
  const readSample = async (): Promise<SampleJob[]> => {
    const jobs: SampleJob[] = [];
    for (const row of await listJobs(rpc, batch.id, deps.signal)) {
      const job = sampleJobFromRow(row, byKey.get(String(row.source_key)));
      if (job && byKey.has(job.sourceKey)) jobs.push(job);
    }
    return jobs;
  };
  const learn = (jobs: SampleJob[]) => {
    for (const job of jobs) if (['ready', 'needs_review', 'failed', 'quarantined'].includes(job.status)) classes.set(job.sourceKey, job.docClass);
  };
  learn(await readSample());

  for (let round = 0; round < MAX_SAMPLE_ROUNDS; round += 1) {
    const selection = selectSample(entries, classes, batch.id);
    const fresh = selection.entries.filter((entry) => !classes.has(entry.sourceKey));
    if (fresh.length === 0) break;
    const enqueued = await enqueueRun(batch, fresh, { rpc, signal: deps.signal, kind: 'dry_run', snapshot: () => sampleQueueConfig(config) });
    deps.io.out(`[Backfill] sample round ${round + 1}: ${fresh.length} files (${enqueued.enqueued} new jobs), sample size ${selection.entries.length} of at most ${selection.cap}`);
    await runAndMonitor(ctx);
    const jobs = await readSample();
    learn(jobs);
    for (const entry of fresh) if (!classes.has(entry.sourceKey)) classes.set(entry.sourceKey, null);
  }
  return readSample();
}

/**
 * The `rag:backfill` state machine (D-31 to D-34, D-36, D-37): batch → inventory and dedupe → (embeddings-only budget check) → sample dry
 * run → report stored on the batch and printed → budget gate → enqueue at priority 10 → monitor → end report. Without a budget, or with
 * --dry-run, it stops after the report (exit 2); a projection that does not fit is refused (exit 3). --resume re-reads the inventory and
 * continues: a running batch goes straight back to enqueue and monitor (terminal jobs are never enqueued again), a finished batch only
 * prints its end report. Nothing here activates an embedding profile.
 */
export async function runBackfill(request: BackfillRequest, deps: OrchestrateDeps): Promise<BackfillOutcome> {
  const { io, signal } = deps;
  const rpc = rpcOf(deps);
  const tenantKey = scopeKey(request.scope).toLowerCase();

  let row: BatchRow;
  if (request.resumeBatchId) {
    row = await updateBatch(rpc, request.resumeBatchId, signal);
    if (row.tenantKey !== tenantKey) throw new BackfillUsageError('the batch belongs to another tenant');
    if (request.source && (request.source.kind !== row.sourceKind || normalisedRef(request.source.kind, request.source.ref) !== row.sourceRef)) {
      throw new BackfillUsageError('--source differs from the source the batch was started with');
    }
    io.out(`[Backfill] resuming batch ${row.id} (${row.status})`);
    if (row.runner !== request.runner) io.out(`[Backfill] note: the batch was started with the ${row.runner} runner; this run uses ${request.runner}`);
  } else {
    if (!request.source) throw new BackfillUsageError('--source is required');
    const created = await call(
      rpc,
      'rag_create_ingestion_batch',
      {
        p_tenant_key: tenantKey,
        p_source_kind: request.source.kind,
        p_source_ref: normalisedRef(request.source.kind, request.source.ref),
        p_budget_usd: request.budgetUsd,
        p_concurrency: request.concurrency,
        p_runner: request.runner,
        p_created_by: 'rag:backfill',
      },
      signal,
    );
    row = batchRowOf(created);
    io.out(`[Backfill] batch ${row.id} created for tenant ${row.tenantKey} (concurrency ${row.concurrency}, runner ${row.runner})`);
  }
  const batch: BackfillBatchRef = { id: row.id, scope: request.scope };
  const ctx: RunContext = { rpc, batch, deps, runner: request.runner };

  if (row.status === 'completed') {
    const end = await endReport(batch, { rpc, signal });
    for (const line of formatEndReport(end)) io.out(line);
    return { exitCode: EXIT.ok, batchId: row.id, report: null, end };
  }
  if (row.status === 'failed' || row.status === 'cancelled') {
    io.err(`[Backfill] batch ${row.id} is ${row.status} and cannot be resumed`);
    return { exitCode: EXIT.failed, batchId: row.id, report: null, end: null };
  }
  if (row.sourceKind === 'manifest' && !request.root) throw new BackfillUsageError('a manifest source needs --root <dir>');

  // D-33 step 1: inventory and dedupe; the opened streams are kept by source key for the enqueue.
  const openers = new Map<string, SourceItem['open']>();
  let rejected = 0;
  const sourceDeps: BackfillSourceDeps = {
    ...(deps.sourceDeps ?? (row.sourceKind === 'bucket' ? defaultSourceDeps() : {})),
    onReject: (reason) => {
      rejected += 1;
      deps.sourceDeps?.onReject?.(reason);
    },
  };
  const listed = listSource({
    kind: row.sourceKind,
    ref: row.sourceRef,
    signal,
    deps: sourceDeps,
    ...(row.sourceKind === 'bucket' ? { allowedBuckets: [row.sourceRef], scope: request.scope } : {}),
    ...(row.sourceKind === 'manifest' && request.root ? { root: path.resolve(request.root) } : {}),
  });
  async function* remembered(): AsyncGenerator<SourceItem> {
    for await (const item of listed) {
      openers.set(item.sourceKey, item.open.bind(item));
      yield item;
    }
  }
  const inv = await inventory(batch, remembered(), { rpc, signal });
  const entries: RunEntry[] = inv.entries.map((entry) => ({ ...entry, open: openers.get(entry.sourceKey) as SourceItem['open'] }));
  io.out(
    `[Backfill] inventory: ${inv.totals.total} files, ${inv.totals.uniqueNew} new, ${inv.totals.inInventoryDuplicates} duplicates inside the source, ${inv.totals.existingDuplicates} already in the knowledge base, ${inv.totals.unreadable} unreadable${rejected > 0 ? `, ${rejected} refused` : ''}`,
  );

  const config = (deps.snapshot ?? queueConfigFromProcessEnv)();
  if (row.status !== 'running') {
    const profiles = await (deps.profiles ?? projectionProfiles)();
    const projection: ProjectionSnapshot = {
      routing: config.parseRouting,
      cloudAllowed: config.parserAllowCloud,
      premiumPageBudget: config.premiumPageBudget,
      routingConfig: loadRoutingConfig(),
      workerConcurrency: config.workerConcurrency,
      batchConcurrency: row.concurrency,
      runner: request.runner,
      embedBatchMode: config.embedBatchMode,
      profiles,
    };
    const willRun = row.budgetUsd !== null && !request.dryRun;

    // D-32: a budget the embeddings of the plain text files alone already exceed is refused before the sample spends anything.
    if (willRun) {
      const floor = embeddingLowerBoundUsd(entries, projection);
      if (floor > (row.budgetUsd as number)) {
        io.err(
          `[Backfill] refused: the projected embedding cost alone (at least ${money(floor)} USD) exceeds the budget of ${money(row.budgetUsd as number)} USD`,
        );
        await updateBatch(rpc, row.id, signal, { status: 'pending' });
        return { exitCode: EXIT.overBudget, batchId: row.id, report: null, end: null };
      }
    }

    // D-33 steps 2 and 3: the sample always runs, then the report is stored on the batch and printed.
    await updateBatch(rpc, row.id, signal, { status: 'sampling' });
    const sampleJobs = await runSample(ctx, entries, config);
    const current = await updateBatch(rpc, row.id, signal);
    const report = buildReport({ budgetUsd: current.budgetUsd, spentUsd: current.spentUsd }, sampleJobs, { entries, duplicates: inv.duplicates }, projection);
    await updateBatch(rpc, row.id, signal, { report });
    io.out(`[Backfill] dry-run report for batch ${row.id}`);
    for (const line of formatReport(report)) io.out(`[Backfill] ${line}`);
    if (config.parseRouting === 'fixed') {
      io.out('[Backfill] note: routing is fixed, so the run parses through the Phase 3 chain; the tiers above are what tiered routing would choose');
    }

    // D-33 step 4: run only with a budget the projection fits.
    const stop = async (exitCode: number, message: string): Promise<BackfillOutcome> => {
      io.err(message);
      await releaseStagedOriginals(batch, { rpc, signal });
      await updateBatch(rpc, row.id, signal, { status: 'pending' });
      return { exitCode, batchId: row.id, report, end: null };
    };
    if (!willRun) {
      return stop(
        EXIT.reportOnly,
        request.dryRun
          ? `[Backfill] --dry-run: stopped after the report; batch ${row.id}`
          : `[Backfill] no --budget: stopped after the report; run again with --budget <USD> to ingest`,
      );
    }
    const budget = row.budgetUsd as number;
    if (report.projected_cost.embeddings_usd > budget) {
      return stop(
        EXIT.overBudget,
        `[Backfill] refused: the projected embedding cost alone (${money(report.projected_cost.embeddings_usd)} USD) exceeds the budget of ${money(budget)} USD`,
      );
    }
    if (!report.fits_budget) {
      const needed = current.spentUsd + report.projected_cost.total_usd;
      return stop(
        EXIT.overBudget,
        `[Backfill] refused: the projection (${money(report.projected_cost.total_usd)} USD, plus ${money(current.spentUsd)} USD already reserved) exceeds the budget of ${money(budget)} USD; short by ${money(
          Math.max(0, needed - budget),
        )} USD`,
      );
    }
    await updateBatch(rpc, row.id, signal, { status: 'running' });
  }

  // D-33 step 4 and D-34: enqueue at priority 10 (re-entrant; terminal jobs are never enqueued again), then monitor until done.
  const enqueued = await enqueueRun(batch, entries, { rpc, signal, kind: 'ingest', snapshot: () => config });
  const refused = Object.entries(enqueued.refused)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  io.out(`[Backfill] run: ${enqueued.enqueued} jobs enqueued, ${enqueued.existing} already in the batch${refused ? `, refused: ${refused}` : ''}`);
  await runAndMonitor(ctx);
  const end = await finishBatch(batch, { rpc, signal, io });
  return { exitCode: EXIT.ok, batchId: row.id, report: null, end };
}
