import type { SupabaseClient } from '@supabase/supabase-js';

/** Phase 4.1.1's service-role miss recorder (0473): rag_term_record_miss(p_tenant_key text, p_row jsonb). */
export const MISS_RECORDER_RPC = 'rag_term_record_miss';
/** D-17: the review reasons that reach the vocabulary miner. */
export const BRIDGE_REASONS: readonly string[] = ['feedback_negative', 'refusal_disputed', 'zero_results'];
export const BRIDGE_QUERY_MAX_CHARS = 500;
/** Upper bound on the items read back per tenant and run. */
export const BRIDGE_MAX_ITEMS_PER_TENANT = 1000;

const ITEM_COLUMNS =
  'tenant_key, query_masked, query_language, channel, outcome, retrieval_config_hash, reasons, mined_at, rag_retrieval_log(tenant_key, status, top_score)';
const MISSING_FUNCTION_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883']);
const PROFILES: ReadonlySet<string> = new Set(['chat', 'embed', 'voice']);
const STATUSES: ReadonlySet<string> = new Set(['ok', 'empty', 'degraded', 'error']);
const OUTCOME_STATUS: Readonly<Record<string, string>> = {
  answered: 'ok',
  refused_no_context: 'empty',
  kb_unavailable: 'error',
  degraded_answer: 'degraded',
};
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;
const DAY_MS = 86_400_000;

export interface BridgeTenant {
  tenantKey: string;
  /** The number of review items this run inserted for the tenant. */
  inserted: number;
}

export interface BridgeInput {
  /** The run's until; the items carry date_trunc('week', until, 'UTC') as their mining window. */
  until: Date;
  tenants: readonly BridgeTenant[];
}

export interface BridgeDeps {
  /** The service-role client. */
  client: SupabaseClient;
  /** RAG_TERMINOLOGY_MINING. */
  enabled: boolean;
  log?: (line: string) => void;
}

export interface BridgeCounts {
  recorded: number;
  skipped: number;
  failed: number;
}

interface ItemRow {
  tenant_key?: unknown;
  query_masked?: unknown;
  query_language?: unknown;
  channel?: unknown;
  outcome?: unknown;
  retrieval_config_hash?: unknown;
  reasons?: unknown;
  mined_at?: unknown;
  rag_retrieval_log?: unknown;
}

interface LogRow {
  tenant_key?: unknown;
  status?: unknown;
  top_score?: unknown;
}

/** UTC Monday 00:00 of the week holding until, as date_trunc('week', until, 'UTC'). */
export function miningWindowStart(until: Date): Date {
  const day = Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate());
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * DAY_MS);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function language(value: unknown): string | null {
  const tag = text(value)?.toLowerCase() ?? null;
  return tag !== null && LANGUAGE.test(tag) ? tag : null;
}

function logOf(row: ItemRow, tenantKey: string): LogRow | null {
  const log = Array.isArray(row.rag_retrieval_log) ? row.rag_retrieval_log[0] : row.rag_retrieval_log;
  if (!log || typeof log !== 'object') return null;
  return (log as LogRow).tenant_key === tenantKey ? (log as LogRow) : null;
}

function status(row: ItemRow, log: LogRow | null): string {
  if (typeof log?.status === 'string' && STATUSES.has(log.status)) return log.status;
  const mapped = typeof row.outcome === 'string' ? OUTCOME_STATUS[row.outcome] : undefined;
  if (mapped) return mapped;
  return Array.isArray(row.reasons) && row.reasons.includes('zero_results') ? 'empty' : 'ok';
}

/** The fixed field list of D-17: nothing else of the item is copied. Null when the item cannot form a valid miss. */
export function missRowFromItem(row: ItemRow, tenantKey: string): Record<string, unknown> | null {
  if (row.tenant_key !== tenantKey) return null;
  if (!Array.isArray(row.reasons) || !row.reasons.some((reason) => BRIDGE_REASONS.includes(reason as string))) return null;
  const query = text(row.query_masked)?.trim() ?? '';
  const hash = text(row.retrieval_config_hash);
  const profile = text(row.channel);
  if (query === '' || hash === null || hash.length > 128 || profile === null || !PROFILES.has(profile)) return null;
  const log = logOf(row, tenantKey);
  const score = log?.top_score;
  return {
    source: 'feedback',
    query_masked: Array.from(query).slice(0, BRIDGE_QUERY_MAX_CHARS).join(''),
    language: language(row.query_language),
    status: status(row, log),
    top_score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    retrieval_config_hash: hash,
    profile,
  };
}

/** This run's items for the tenant: the newest rows of the mining week, all with one mined_at, exactly as many as the run inserted. */
async function readRunItems(client: SupabaseClient, tenant: BridgeTenant, window: string): Promise<ItemRow[] | null> {
  const limit = Math.min(tenant.inserted, BRIDGE_MAX_ITEMS_PER_TENANT);
  const { data, error } = (await client
    .from('rag_review_items')
    .select(ITEM_COLUMNS)
    .eq('tenant_key', tenant.tenantKey)
    .eq('mining_window', window)
    .order('mined_at', { ascending: false })
    .limit(limit)) as unknown as { data: unknown; error: unknown };
  if (error || !Array.isArray(data)) return null;
  const rows = data as ItemRow[];
  const minedAt = rows[0]?.mined_at;
  if (rows.length !== limit || rows.some((row) => row.mined_at !== minedAt || row.tenant_key !== tenant.tenantKey)) return null;
  return rows;
}

function errorCode(error: unknown): string | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
}

/**
 * D-17 with Phase 4.1.1 D-25/D-25a: after a completed mining run, writes each newly inserted review item with reason
 * feedback_negative, refusal_disputed or zero_results into rag_term_misses through rag_term_record_miss, source 'feedback',
 * under that item's own tenant key. Off unless RAG_TERMINOLOGY_MINING is true; a missing recorder (4.1.1 not deployed) skips.
 * Reads no candidate or dictionary table. Never rejects; logs counts and codes only, never a query.
 */
export async function bridgeToTerminologyMisses(input: BridgeInput, deps: BridgeDeps): Promise<BridgeCounts> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const counts: BridgeCounts = { recorded: 0, skipped: 0, failed: 0 };
  if (!deps.enabled) {
    log('[Feedback Loop] terminology bridge skipped (terminology_mining_off)');
    return counts;
  }
  const window = miningWindowStart(input.until).toISOString();
  let failure: string | null = null;
  try {
    for (const tenant of input.tenants) {
      if (!(tenant.inserted > 0)) continue;
      const rows = await readRunItems(deps.client, tenant, window);
      if (!rows) {
        counts.failed += 1;
        failure ??= 'read_items';
        continue;
      }
      for (const row of rows) {
        const miss = missRowFromItem(row, tenant.tenantKey);
        if (!miss) {
          counts.skipped += 1;
          continue;
        }
        try {
          const { error } = (await deps.client.rpc(MISS_RECORDER_RPC, { p_tenant_key: tenant.tenantKey, p_row: miss })) as unknown as {
            error: unknown;
          };
          if (!error) {
            counts.recorded += 1;
            continue;
          }
          const code = errorCode(error);
          if (code !== null && MISSING_FUNCTION_CODES.has(code)) {
            log('[Feedback Loop] terminology bridge skipped (recorder_missing)');
            return { recorded: 0, skipped: 0, failed: 0 };
          }
          counts.failed += 1;
          failure ??= code !== null && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : 'rpc_error';
        } catch {
          counts.failed += 1;
          failure ??= 'exception';
        }
      }
    }
  } catch {
    counts.failed += 1;
    failure ??= 'exception';
  }
  if (failure !== null) log(`[Feedback Loop] terminology bridge failed (${failure}) ${JSON.stringify(counts)}`);
  else log(`[Feedback Loop] terminology bridge ${JSON.stringify(counts)}`);
  return counts;
}
