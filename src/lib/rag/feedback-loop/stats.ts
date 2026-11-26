import type { SupabaseClient } from '@supabase/supabase-js';
import { FeedbackLoopStatsSchema, type FeedbackLoopStats } from '@/lib/rag-eval/contracts.generated';
import { getRagDeps } from '../deps';
import { loadFeedbackMiningConfig, type FeedbackMiningConfig } from './config';
import { tenantHash } from './mining';

export const MAX_STATS_WINDOW_DAYS = 92;
export const DEFAULT_STATS_WINDOW_DAYS = 7;
export const STATS_PAGE_SIZE = 1000;
export const STATS_MAX_ROWS = 1_000_000;

const DAY_MS = 86_400_000;
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ERROR_CODE = /^[A-Za-z0-9_]{1,32}$/;
const CHANNELS = ['chat', 'embed', 'voice'] as const;
const OUTCOMES = ['answered', 'refused_no_context', 'kb_unavailable', 'degraded_answer', 'unknown'] as const;
const TRIAGE = ['dictionary', 'training', 'golden', 'kb_gap', 'not_a_failure'] as const;
const WINDOW_ERRORS = new Set(['invalid_window', 'window_too_long']);

type TenantStats = NonNullable<FeedbackLoopStats['tenants']>[number];

/** Carries a code only; database messages never reach the caller's output. */
export class StatsError extends Error {
  constructor(readonly code: string) {
    super(`[Feedback Loop] stats failed (${code})`);
    this.name = 'StatsError';
  }
}

export function isStatsWindowError(error: unknown): boolean {
  return error instanceof StatsError && WINDOW_ERRORS.has(error.code);
}

export interface StatsWindowInput {
  since?: Date;
  until?: Date;
}

export interface FeedbackLoopStatsDeps {
  /** Defaults to the admin client from the RAG deps. */
  client?: SupabaseClient | null;
  loadConfig?: () => { config: FeedbackMiningConfig; sha256: string };
  now?: () => number;
  pageSize?: number;
  maxRows?: number;
}

interface LogRow {
  tenant_key: unknown;
  channel: unknown;
  outcome: unknown;
  candidate_count: unknown;
  top_score: unknown;
  feedback_vote: unknown;
  feedback_kind: unknown;
  source_opened_count: unknown;
  rerank_score: unknown;
}

interface ItemRow {
  tenant_key: unknown;
  status?: unknown;
  triage?: unknown;
}

interface Tally {
  stats: TenantStats;
  zero: number;
  low: number;
  opened: number;
}

function validDate(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function resolveWindow(input: StatsWindowInput, now: number): { since: Date; until: Date } {
  if ((input.until !== undefined && !validDate(input.until)) || (input.since !== undefined && !validDate(input.since))) {
    throw new StatsError('invalid_window');
  }
  const until = input.until ?? new Date(now);
  const since = input.since ?? new Date(until.getTime() - DEFAULT_STATS_WINDOW_DAYS * DAY_MS);
  if (since.getTime() >= until.getTime()) throw new StatsError('invalid_window');
  if (until.getTime() - since.getTime() > MAX_STATS_WINDOW_DAYS * DAY_MS) throw new StatsError('window_too_long');
  return { since, until };
}

function errorCode(error: unknown): string {
  if (error instanceof StatsError) return error.code;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  }
  return 'database_error';
}

function emptyStats(hash: string): TenantStats {
  return {
    tenant_hash: hash,
    retrievals: 0,
    retrievals_by_channel: { chat: 0, embed: 0, voice: 0 },
    outcomes: { answered: 0, refused_no_context: 0, kb_unavailable: 0, degraded_answer: 0, unknown: 0 },
    refusal_rate: null,
    zero_result_rate: null,
    low_score_rate: null,
    votes: { answer_up: 0, answer_down: 0, refusal_up: 0, refusal_down: 0, embed_up: 0, embed_down: 0 },
    thumbs_down_rate: null,
    refusal_disputes: 0,
    source_open_rate: null,
    items_mined: 0,
    items_labelled: 0,
    items_skipped: 0,
    items_exported: 0,
    triage: { dictionary: 0, training: 0, golden: 0, kb_gap: 0, not_a_failure: 0 },
  };
}

function tenantOf(value: unknown): string {
  if (typeof value !== 'string' || !TENANT_KEY.test(value)) throw new StatsError('unexpected_result');
  return value;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & {
  range: (from: number, to: number) => Query;
};

async function readPages<T>(build: () => Query, pageSize: number, maxRows: number): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw new StatsError(errorCode(error));
    if (!Array.isArray(data)) throw new StatsError('unexpected_result');
    rows.push(...(data as T[]));
    if (rows.length > maxRows) throw new StatsError('too_many_rows');
    if (data.length < pageSize) return rows;
  }
}

/**
 * D-25: aggregate loop statistics for [since, until), per tenant hash. Reads rag_retrieval_log by created_at and
 * rag_review_items by mined_at (items mined) and labelled_at (labelled, skipped and exported, with triage) on the admin
 * client. Counts and rates only: no tenant key, query, answer or chunk text leaves this function. The window defaults to the
 * last 7 days and is at most 92 days. Throws StatsError with a code.
 */
export async function computeFeedbackLoopStats(
  input: StatsWindowInput = {},
  deps: FeedbackLoopStatsDeps = {},
): Promise<FeedbackLoopStats> {
  const now = (deps.now ?? Date.now)();
  const { since, until } = resolveWindow(input, now);
  const pageSize = deps.pageSize ?? STATS_PAGE_SIZE;
  const maxRows = deps.maxRows ?? STATS_MAX_ROWS;

  let config: FeedbackMiningConfig;
  try {
    config = (deps.loadConfig ?? loadFeedbackMiningConfig)().config;
  } catch {
    throw new StatsError('invalid_mining_config');
  }

  const client = deps.client === undefined ? getRagDeps().adminClient() : deps.client;
  if (!client) throw new StatsError('no_admin_client');
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  let logRows: LogRow[];
  let minedRows: ItemRow[];
  let labelledRows: ItemRow[];
  try {
    [logRows, minedRows, labelledRows] = await Promise.all([
      readPages<LogRow>(
        () =>
          client
            .from('rag_retrieval_log')
            .select(
              'tenant_key,channel,outcome,candidate_count,top_score,feedback_vote,feedback_kind,source_opened_count,rerank_score:candidates->0->rerank_score',
            )
            .gte('created_at', sinceIso)
            .lt('created_at', untilIso)
            .not('tenant_key', 'is', null)
            .order('id', { ascending: true }) as unknown as Query,
        pageSize,
        maxRows,
      ),
      readPages<ItemRow>(
        () =>
          client
            .from('rag_review_items')
            .select('tenant_key')
            .gte('mined_at', sinceIso)
            .lt('mined_at', untilIso)
            .order('id', { ascending: true }) as unknown as Query,
        pageSize,
        maxRows,
      ),
      readPages<ItemRow>(
        () =>
          client
            .from('rag_review_items')
            .select('tenant_key,status,triage')
            .gte('labelled_at', sinceIso)
            .lt('labelled_at', untilIso)
            .order('id', { ascending: true }) as unknown as Query,
        pageSize,
        maxRows,
      ),
    ]);
  } catch (error) {
    throw error instanceof StatsError ? error : new StatsError(errorCode(error));
  }

  const tallies = new Map<string, Tally>();
  const tally = (tenantKey: unknown): Tally => {
    const key = tenantOf(tenantKey);
    let entry = tallies.get(key);
    if (!entry) {
      entry = { stats: emptyStats(tenantHash(key)), zero: 0, low: 0, opened: 0 };
      tallies.set(key, entry);
    }
    return entry;
  };

  for (const row of logRows) {
    const entry = tally(row.tenant_key);
    const stats = entry.stats;
    stats.retrievals += 1;
    if (CHANNELS.includes(row.channel as (typeof CHANNELS)[number])) stats.retrievals_by_channel[row.channel as (typeof CHANNELS)[number]] += 1;
    const outcome = OUTCOMES.includes(row.outcome as (typeof OUTCOMES)[number]) ? (row.outcome as (typeof OUTCOMES)[number]) : 'unknown';
    stats.outcomes[outcome] += 1;

    const candidates = finiteNumber(row.candidate_count) ?? 0;
    if (candidates === 0 && outcome !== 'kb_unavailable') entry.zero += 1;
    const top = finiteNumber(row.top_score);
    const ceiling = finiteNumber(row.rerank_score) !== null ? config.low_score_ceiling.rerank : config.low_score_ceiling.similarity;
    if (outcome === 'answered' && top !== null && top < ceiling) entry.low += 1;
    if (outcome === 'answered' && (finiteNumber(row.source_opened_count) ?? 0) > 0) entry.opened += 1;

    const vote = finiteNumber(row.feedback_vote);
    const kind = row.feedback_kind;
    if ((vote === 1 || vote === -1) && (kind === 'answer' || kind === 'refusal' || kind === 'embed')) {
      stats.votes[`${kind}_${vote === 1 ? 'up' : 'down'}`] += 1;
      if (kind === 'refusal' && vote === -1) stats.refusal_disputes += 1;
    }
  }

  for (const row of minedRows) tally(row.tenant_key).stats.items_mined += 1;

  for (const row of labelledRows) {
    const stats = tally(row.tenant_key).stats;
    if (row.status === 'skipped') {
      stats.items_skipped += 1;
      continue;
    }
    if (row.status !== 'labelled' && row.status !== 'exported') continue;
    stats.items_labelled += 1;
    if (row.status === 'exported') stats.items_exported += 1;
    const triage = Array.isArray(row.triage) ? new Set(row.triage) : new Set();
    for (const kind of TRIAGE) if (triage.has(kind)) stats.triage[kind] += 1;
  }

  const tenants = [...tallies.values()]
    .map(({ stats, zero, low, opened }) => {
      const votes = stats.votes;
      const up = votes.answer_up + votes.refusal_up + votes.embed_up;
      const down = votes.answer_down + votes.refusal_down + votes.embed_down;
      return {
        ...stats,
        refusal_rate: rate(stats.outcomes.refused_no_context, stats.retrievals),
        zero_result_rate: rate(zero, stats.retrievals),
        low_score_rate: rate(low, stats.outcomes.answered),
        thumbs_down_rate: rate(down, up + down),
        source_open_rate: rate(opened, stats.outcomes.answered),
      };
    })
    .sort((a, b) => a.tenant_hash.localeCompare(b.tenant_hash));

  return FeedbackLoopStatsSchema.parse({ schema_version: 1, since: sinceIso, until: untilIso, tenants });
}
