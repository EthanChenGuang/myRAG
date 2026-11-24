import type { RpcClient } from '../../backend/supabase-rpc';
import { getIngestDeps } from '../deps';
import { loadQueueConfig, type QueueEnvSnapshot } from '../queue-config';

export type CloudKind = 'parse' | 'vlm';
export type CloudRefusal = 'cloud_not_allowed' | 'over_page_cap' | 'budget_exhausted' | 'batch_budget_exhausted';
export type CloudGate = { ok: true } | { ok: false; reason: CloudRefusal };

/** An open page reservation; settle and release address it by job id and attempt. */
export interface Reservation {
  jobId: string;
  attemptNo: number;
  kind: CloudKind;
  pages: number;
}

/** `handle` is null when the call was not metered (inline and fixed runs: only the cloud switch applies). */
export type ReserveResult = { ok: true; handle: Reservation | null } | { ok: false; reason: CloudRefusal };

export interface PremiumContext {
  jobId?: string;
  attemptNo?: number;
  /** Pages of this document that go to the cloud call. */
  pages: number;
  /** Estimated USD of the call, counted against the job's batch budget. */
  estUsd?: number;
  routing: 'fixed' | 'tiered';
  /** True for a job taken from the ingestion queue. Budget and cap apply to queued tiered jobs only (D-17). */
  queued: boolean;
}

export interface GuardConfig {
  parserAllowCloud: boolean;
  premiumPageBudget: number;
  premiumMaxPagesPerDoc: number;
}

export interface GuardDeps {
  db: () => RpcClient | null;
  config: () => GuardConfig;
}

export interface MonthlyUsageRow {
  tenant_key: string;
  month: string;
  pages_reserved: number;
  pages_used: number;
  vlm_pages_used: number;
}

/** Thrown by a cloud client when the guard refuses; `reason` is one of the four refusal codes. */
export class CloudRefused extends Error {
  readonly reason: CloudRefusal;

  constructor(reason: CloudRefusal) {
    super(`[Ingest] cloud call refused (${reason})`);
    this.name = 'CloudRefused';
    this.reason = reason;
  }
}

/** A budget function failed or the database is not reachable. The guard fails closed; the message never carries row content. */
export class CloudGuardError extends Error {
  readonly rpc: string;
  readonly code: string | null;

  constructor(rpc: string, code: string | null) {
    super(`[Ingest] cloud guard ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'CloudGuardError';
    this.rpc = rpc;
    this.code = code;
  }
}

export interface GuardCallOptions {
  signal?: AbortSignal;
  deps?: Partial<GuardDeps>;
}

const QUEUE_ENV_KEYS = [
  'RAG_INGEST_PIPELINE',
  'RAG_PARSE_ROUTING',
  'RAG_PARSER_ALLOW_CLOUD',
  'RAG_PARSE_PREMIUM_PAGE_BUDGET',
  'RAG_PARSE_PREMIUM_MAX_PAGES_PER_DOC',
  'RAG_INGEST_ASYNC',
] as const satisfies readonly (keyof QueueEnvSnapshot)[];

// env.ts is read once at import; the switch and the budget are hard constraints that must follow the process environment on every call (D-08, D-18).
function liveConfig(): GuardConfig {
  const snapshot: QueueEnvSnapshot = {};
  for (const key of QUEUE_ENV_KEYS) snapshot[key] = process.env[key];
  const config = loadQueueConfig(snapshot);
  return {
    parserAllowCloud: config.parserAllowCloud,
    premiumPageBudget: config.premiumPageBudget,
    premiumMaxPagesPerDoc: config.premiumMaxPagesPerDoc,
  };
}

const defaults: GuardDeps = {
  db: () => getIngestDeps().db(),
  config: liveConfig,
};

let overrides: Partial<GuardDeps> = {};

function deps(options: GuardCallOptions): GuardDeps {
  return { ...defaults, ...overrides, ...options.deps };
}

export function setCloudGuardDepsForTests(partial: Partial<GuardDeps>): void {
  overrides = { ...overrides, ...partial };
}

export function resetCloudGuardDepsForTests(): void {
  overrides = {};
}

function refuse(reason: CloudRefusal, kind: CloudKind): { ok: false; reason: CloudRefusal } {
  console.warn('[Ingest] cloud call refused', { reason, kind });
  return { ok: false, reason };
}

/**
 * The cloud switch, read live. Every cloud call in every mode starts here; nothing else in the unified pipeline decides whether a
 * document may leave the deployment.
 */
export function assertCloudAllowed(kind: CloudKind, options: GuardCallOptions = {}): CloudGate {
  if (!deps(options).config().parserAllowCloud) return refuse('cloud_not_allowed', kind);
  return { ok: true };
}

async function call(
  db: RpcClient | null,
  fn: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown[] | null> {
  if (!db) throw new CloudGuardError(fn, 'db_unavailable');
  let response;
  try {
    const request = db.rpc(fn, args);
    response = await (signal ? request.abortSignal(signal) : request);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CloudGuardError(fn, 'rpc_failed');
  }
  if (response.error) throw new CloudGuardError(fn, response.error.code ?? null);
  return response.data;
}

/** A boolean function answers a scalar through PostgREST and a one-row set elsewhere. */
function truthy(data: unknown, fn: string): boolean {
  if (data === true) return true;
  if (!Array.isArray(data)) return false;
  const row: unknown = data[0];
  if (row === true) return true;
  return typeof row === 'object' && row !== null && (row as Record<string, unknown>)[fn] === true;
}

async function giveBack(client: RpcClient | null, handle: Reservation, signal: AbortSignal | undefined): Promise<void> {
  await call(client, 'rag_release_parse_budget', { p_job_id: handle.jobId, p_attempt_no: handle.attemptNo, p_kind: handle.kind }, signal);
}

async function reserve(kind: CloudKind, context: PremiumContext, options: GuardCallOptions): Promise<ReserveResult> {
  const { config, db } = deps(options);
  const settings = config();
  if (!settings.parserAllowCloud) return refuse('cloud_not_allowed', kind);

  // Budget and cap meter queued tiered jobs only; inline and fixed runs keep Phase 3's unmetered use (D-17).
  if (!context.queued || context.routing !== 'tiered' || !context.jobId) return { ok: true, handle: null };

  if (kind === 'parse' && context.pages > settings.premiumMaxPagesPerDoc) return refuse('over_page_cap', kind);

  const handle: Reservation = { jobId: context.jobId, attemptNo: context.attemptNo ?? 1, kind, pages: context.pages };
  const client = db();
  const reserved = await call(
    client,
    'rag_reserve_parse_budget',
    { p_job_id: handle.jobId, p_attempt_no: handle.attemptNo, p_pages: handle.pages, p_kind: kind, p_limit: settings.premiumPageBudget },
    options.signal,
  );
  if (!truthy(reserved, 'rag_reserve_parse_budget')) return refuse('budget_exhausted', kind);

  try {
    const fits = await call(client, 'rag_reserve_batch_budget', { p_job_id: handle.jobId, p_usd: context.estUsd ?? 0 }, options.signal);
    if (!truthy(fits, 'rag_reserve_batch_budget')) {
      await giveBack(client, handle, options.signal);
      return refuse('batch_budget_exhausted', kind);
    }
  } catch (error) {
    await giveBack(client, handle, options.signal).catch(() => undefined);
    throw error;
  }
  return { ok: true, handle };
}

/**
 * Cloud switch, then the per-document page cap, then the tenant's page reservation, then the batch's USD reservation. A refused call
 * reserves nothing: a page reservation taken before the batch refused is released again.
 */
export function reservePremium(context: PremiumContext, options: GuardCallOptions = {}): Promise<ReserveResult> {
  return reserve('parse', context, options);
}

/** The same checks for the L3 vision call, counted as kind vlm against the same monthly budget. The per-document premium cap does not apply. */
export function reserveVlm(context: PremiumContext, options: GuardCallOptions = {}): Promise<ReserveResult> {
  return reserve('vlm', context, options);
}

export async function settle(handle: Reservation, pagesSent: number, options: GuardCallOptions = {}): Promise<boolean> {
  const data = await call(
    deps(options).db(),
    'rag_settle_parse_budget',
    { p_job_id: handle.jobId, p_attempt_no: handle.attemptNo, p_kind: handle.kind, p_pages_used: pagesSent },
    options.signal,
  );
  return truthy(data, 'rag_settle_parse_budget');
}

export async function release(handle: Reservation, options: GuardCallOptions = {}): Promise<boolean> {
  const data = await call(
    deps(options).db(),
    'rag_release_parse_budget',
    { p_job_id: handle.jobId, p_attempt_no: handle.attemptNo, p_kind: handle.kind },
    options.signal,
  );
  return truthy(data, 'rag_release_parse_budget');
}

/** This UTC month's use per tenant, for the admin view; no tenant key lists every tenant. */
export async function readMonthlyUsage(tenantKey?: string, options: GuardCallOptions = {}): Promise<MonthlyUsageRow[]> {
  const data = await call(deps(options).db(), 'rag_parse_budget_month', { p_tenant_key: tenantKey ?? null }, options.signal);
  return Array.isArray(data) ? (data as MonthlyUsageRow[]) : [];
}
