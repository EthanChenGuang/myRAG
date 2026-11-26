import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MiningRunResultSchema, type MiningRunResult } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps } from '../deps';
import { loadFeedbackMiningConfig, readFeedbackLoopConfig, type FeedbackLoopEnvSource, type FeedbackMiningConfig } from './config';
import { purgeRetrievalLog, PurgeError, type PurgeCounts } from './purge';
import { bridgeToTerminologyMisses, type BridgeTenant } from './terminology-bridge';

export const MAX_MINING_WINDOW_DAYS = 31;
/** The run report around public.rag_mine_failed_queries (0537): its reason rows plus the items each tenant got. */
export const MINING_RPC = 'rag_mine_failed_queries_report';
export const TENANT_HASH_LENGTH = 16;

const DAY_MS = 86_400_000;
const MINING_REASONS = [
  'feedback_negative',
  'refusal_disputed',
  'groundedness_flagged',
  'refused_high_score',
  'zero_results',
  'low_score',
  'no_source_opened',
] as const;
type MiningReason = (typeof MINING_REASONS)[number];
type ReasonCounts = Record<MiningReason, number>;
type TenantResult = NonNullable<MiningRunResult['tenants']>[number];

const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WINDOW_ERRORS = new Set(['invalid_window', 'window_too_long']);

export type MiningDisabledReason = 'domain_expert_review_off' | 'retrieval_log_not_masked_query';

/** Carries a code only; database messages never reach the caller's output. */
export class MiningError extends Error {
  constructor(readonly code: string) {
    super(`[Feedback Loop] mining failed (${code})`);
    this.name = 'MiningError';
  }
}

export interface MiningWindowInput {
  since?: Date;
  until?: Date;
}

export interface RunMiningDeps {
  /** Defaults to the admin client from the RAG deps. */
  client?: SupabaseClient | null;
  env?: FeedbackLoopEnvSource;
  loadConfig?: () => { config: FeedbackMiningConfig; sha256: string };
  purge?: (client: SupabaseClient, retentionDays: number) => Promise<PurgeCounts>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Phase 4.1.1's RAG_TERMINOLOGY_MINING, read with its config rule: only true (any case, trimmed) turns it on. */
export function terminologyMiningEnabled(env: FeedbackLoopEnvSource = process.env): boolean {
  return (env.RAG_TERMINOLOGY_MINING ?? '').trim().toLowerCase() === 'true';
}

function bridgeTenants(rows: MiningRow[]): BridgeTenant[] {
  const byTenant = new Map<string, number>();
  for (const row of rows) byTenant.set(row.tenant_key, row.tenant_inserted);
  return [...byTenant].map(([tenantKey, inserted]) => ({ tenantKey, inserted }));
}

/** A sha256 prefix of the tenant key: reports name tenants by it, never by the key. */
export function tenantHash(tenantKey: string): string {
  return createHash('sha256').update(tenantKey).digest('hex').slice(0, TENANT_HASH_LENGTH);
}

/** YYYY-MM-DD as UTC midnight; anything else, including impossible dates, is null. */
export function parseMiningDate(text: string): Date | null {
  const match = DATE_ONLY.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** D-15: mining needs expert review on and the log in masked_query mode. */
export function miningDisabledReason(env: FeedbackLoopEnvSource = process.env): MiningDisabledReason | null {
  const config = readFeedbackLoopConfig(env, () => undefined);
  if (!config.domainExpertReview) return 'domain_expert_review_off';
  if (config.retrievalLog !== 'masked_query') return 'retrieval_log_not_masked_query';
  return null;
}

export function isMiningWindowError(error: unknown): boolean {
  return error instanceof MiningError && WINDOW_ERRORS.has(error.code);
}

function errorCode(error: unknown): string {
  if (error instanceof PurgeError || error instanceof MiningError) return error.code;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  }
  return 'database_error';
}

function validDate(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function resolveWindow(input: MiningWindowInput, windowDays: number, now: number): { since: Date; until: Date } {
  if ((input.until !== undefined && !validDate(input.until)) || (input.since !== undefined && !validDate(input.since))) {
    throw new MiningError('invalid_window');
  }
  const until = input.until ?? new Date(now);
  const since = input.since ?? new Date(until.getTime() - windowDays * DAY_MS);
  if (since.getTime() >= until.getTime()) throw new MiningError('invalid_window');
  if (until.getTime() - since.getTime() > MAX_MINING_WINDOW_DAYS * DAY_MS) throw new MiningError('window_too_long');
  return { since, until };
}

interface MiningRow {
  tenant_key: string;
  reason: MiningReason;
  inserted: number;
  tenant_inserted: number;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseRows(data: unknown): MiningRow[] {
  if (!Array.isArray(data)) throw new MiningError('unexpected_result');
  return data.map((raw) => {
    const row = raw as Partial<MiningRow> | null;
    if (
      !row ||
      typeof row.tenant_key !== 'string' ||
      !TENANT_KEY.test(row.tenant_key) ||
      !MINING_REASONS.includes(row.reason as MiningReason) ||
      !count(row.inserted) ||
      !count(row.tenant_inserted)
    ) {
      throw new MiningError('unexpected_result');
    }
    return row as MiningRow;
  });
}

function emptyReasons(): ReasonCounts {
  return Object.fromEntries(MINING_REASONS.map((reason) => [reason, 0])) as ReasonCounts;
}

function tenantResults(rows: MiningRow[]): TenantResult[] {
  const byTenant = new Map<string, TenantResult>();
  for (const row of rows) {
    const hash = tenantHash(row.tenant_key);
    let tenant = byTenant.get(row.tenant_key);
    if (!tenant) {
      tenant = { tenant_hash: hash, inserted: row.tenant_inserted, by_reason: emptyReasons() };
      byTenant.set(row.tenant_key, tenant);
    }
    if (tenant.inserted !== row.tenant_inserted) throw new MiningError('unexpected_result');
    tenant.by_reason[row.reason] += row.inserted;
  }
  return [...byTenant.values()].sort((a, b) => a.tenant_hash.localeCompare(b.tenant_hash));
}

/**
 * D-13, D-15: purges the expired log rows and open items, then mines [since, until) into rag_review_items with
 * config/rag/feedback-mining.json. Disabled unless RAG_DOMAIN_EXPERT_REVIEW is true and RAG_RETRIEVAL_LOG is masked_query; a
 * disabled run makes no call. until defaults to now, since to until minus window_days; a window longer than 31 days is refused.
 * The result names tenants by hash and carries counts only. Throws MiningError with a code.
 * A completed run then bridges its new items to Phase 4.1.1's miss log (terminology-bridge.ts); the bridge never changes the result.
 */
export async function runMining(input: MiningWindowInput = {}, deps: RunMiningDeps = {}): Promise<MiningRunResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = (deps.now ?? Date.now)();

  const disabled = miningDisabledReason(env);
  if (disabled) {
    const until = validDate(input.until) ? input.until : new Date(now);
    const since = validDate(input.since) ? input.since : new Date(until.getTime() - 7 * DAY_MS);
    log(`[Feedback Loop] mining disabled (${disabled})`);
    return MiningRunResultSchema.parse({
      schema_version: 1,
      status: 'disabled',
      disabled_reason: disabled,
      since: since.toISOString(),
      until: until.toISOString(),
      tenants: [],
    });
  }

  let loaded: { config: FeedbackMiningConfig; sha256: string };
  try {
    loaded = (deps.loadConfig ?? loadFeedbackMiningConfig)();
  } catch {
    throw new MiningError('invalid_mining_config');
  }
  const { since, until } = resolveWindow(input, loaded.config.window_days, now);

  const client = deps.client === undefined ? getRagDeps().adminClient() : deps.client;
  if (!client) throw new MiningError('no_admin_client');

  const feedbackConfig = readFeedbackLoopConfig(env, () => undefined);
  let purged: PurgeCounts;
  try {
    purged = await (deps.purge ?? purgeRetrievalLog)(client, feedbackConfig.retentionDays);
  } catch (error) {
    throw new MiningError(errorCode(error));
  }

  let rows: MiningRow[];
  try {
    const { data, error } = (await client.rpc(MINING_RPC, {
      p_since: since.toISOString(),
      p_until: until.toISOString(),
      p_config: { ...loaded.config, source_open_signal: feedbackConfig.sourceOpenSignal },
    })) as unknown as { data: unknown; error: unknown };
    if (error) throw new MiningError(errorCode(error));
    rows = parseRows(data);
  } catch (error) {
    throw error instanceof MiningError ? error : new MiningError(errorCode(error));
  }

  const tenants = tenantResults(rows);
  const result = MiningRunResultSchema.parse({
    schema_version: 1,
    status: 'completed',
    disabled_reason: null,
    since: since.toISOString(),
    until: until.toISOString(),
    config_sha256: loaded.sha256,
    purged_log_rows: purged.logRows,
    purged_review_items: purged.reviewItems,
    total_inserted: tenants.reduce((sum, tenant) => sum + tenant.inserted, 0),
    tenants,
  });
  log(
    `[Feedback Loop] mining ${JSON.stringify({
      tenants: tenants.length,
      inserted: result.total_inserted,
      purged_log_rows: result.purged_log_rows,
      purged_review_items: result.purged_review_items,
    })}`,
  );
  try {
    await bridgeToTerminologyMisses(
      { until, tenants: bridgeTenants(rows) },
      { client, enabled: terminologyMiningEnabled(env), log },
    );
  } catch {
    log('[Feedback Loop] terminology bridge failed (exception)');
  }
  return result;
}
