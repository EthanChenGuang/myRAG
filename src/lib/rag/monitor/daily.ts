import type { SupabaseClient } from '@supabase/supabase-js';
import budgetsJson from '../../../../eval/config/latency-budgets.json';
import {
  LatencyBudgetsSchema,
  type LatencyBudgets,
  type MonitorAlertsConfig,
  type MonitorDailyCell,
} from '@/lib/rag-eval/contracts.generated';
import { readFeedbackLoopConfig } from '@/lib/rag/feedback-loop/config';
import { loadMonitorAlertsConfig } from './alerts-config';
import { purgeRuns, recordRun, upsertAlerts, type DeliveryChannel, type UpsertAlertInput } from './alerts-store';
import { monitorSettings, type MonitorEnvInput } from './config';
import { matchForRule, windowConfigChanges } from './correlate';
import type { AlertCandidate, RuleContext, RuleKindRegistry } from './rule-registry';
import { addDays } from './rule-kinds';
import { evaluateRules } from './rules';
import { LATENCY_BIN_EDGES_MS, TOP_SCORE_BINS } from './stats';

export type MonitorRunSource = 'cli' | 'route' | 'schedule';

export interface RunDailyOptions {
  now?: Date;
  source: MonitorRunSource;
  /** The last day of the evaluation window (YYYY-MM-DD, UTC); defaults to the UTC day before `now`. */
  day?: string;
  /** Environment source for the switches; defaults to the process environment. */
  env?: MonitorEnvInput & Record<string, string | undefined>;
  /** Tests pass their own rules and registry; production uses the committed config and RULE_KIND_REGISTRY. */
  config?: MonitorAlertsConfig;
  registry?: RuleKindRegistry;
  budgets?: LatencyBudgets | null;
}

export type RunDailyResult =
  | { ran: false; reason: 'switched_off' | 'log_off' | 'config_invalid' }
  | {
      ran: true;
      day: string;
      daysAggregated: number;
      cellsRead: number;
      groupsChecked: number;
      groupsInsufficient: number;
      candidates: number;
      alertsOpened: number;
      alertsUpdated: number;
      alertsSuppressed: number;
      alertsInvalid: number;
      deliveries: number;
      rulesUnregistered: string[];
      contextRulesFailed: string[];
    };

const TRAILING_DAYS = 7;
const KEEP_DAYS = 400;
const PAGE = 1000;
/** Upper edges of the 0971 latency bins 1 to 20; bin 0 is below 0 ms and bin 21 is 15 s or more. */
const SQL_LATENCY_EDGES = [0, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 4000, 5000, 7500, 10000, 15000];

interface DailyRow {
  tenant_key: string;
  day: string;
  language: string;
  rag_mode: string;
  channel: string;
  doc_type: string;
  retrievals: number;
  refused: number;
  kb_unavailable: number;
  degraded: number;
  error: number;
  zero_result: number;
  below_threshold: number;
  helpful: number;
  not_helpful: number;
  judged: number;
  groundedness_flagged: number;
  judge_score_sums: Record<string, number | string> | null;
  top_score_hist: Record<string, number[]> | null;
  latency_hist: number[] | null;
}

export class MonitorRunError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | null,
  ) {
    super(`[Monitor] ${operation} failed${code ? ` (${code})` : ''}`);
    this.name = 'MonitorRunError';
  }
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The contract latency bin of a 0971 bin: the bin holding the 0971 bin's upper edge (15 s or more falls in 12 s to 20 s). */
function contractLatencyBin(sqlBin: number): number {
  if (sqlBin <= 0) return 0;
  const upper = sqlBin >= SQL_LATENCY_EDGES.length ? SQL_LATENCY_EDGES[SQL_LATENCY_EDGES.length - 1]! + 1 : SQL_LATENCY_EDGES[sqlBin]!;
  const index = LATENCY_BIN_EDGES_MS.findIndex((edge) => upper - 1 < edge);
  return index === -1 ? LATENCY_BIN_EDGES_MS.length : index;
}

function latencyHist(bins: number[] | null): MonitorDailyCell['latency_hist'] {
  const out = new Array<number>(LATENCY_BIN_EDGES_MS.length + 1).fill(0);
  (bins ?? []).forEach((value, i) => {
    out[contractLatencyBin(i)] += Number(value) || 0;
  });
  return { bins: out };
}

function topScoreHist(hist: Record<string, number[]> | null): MonitorDailyCell['top_score_hist'] {
  const out: NonNullable<MonitorDailyCell['top_score_hist']> = {};
  for (const kind of ['rerank', 'similarity'] as const) {
    const bins = hist?.[kind];
    if (!Array.isArray(bins) || bins.length !== TOP_SCORE_BINS + 2) continue;
    out[kind] = {
      underflow: Number(bins[0]) || 0,
      bins: bins.slice(1, TOP_SCORE_BINS + 1).map((value) => Number(value) || 0),
      overflow: Number(bins[TOP_SCORE_BINS + 1]) || 0,
    };
  }
  return out;
}

/** A rag_monitor_daily row (0962/0971 layout) as the MonitorDailyCell the rule engine reads. */
export function toDailyCell(row: DailyRow): MonitorDailyCell {
  const sums: Record<string, number> = {};
  for (const [metric, value] of Object.entries(row.judge_score_sums ?? {})) sums[metric] = Number(value) || 0;
  return {
    tenant_key: row.tenant_key,
    day: String(row.day).slice(0, 10),
    language: row.language,
    rag_mode: row.rag_mode as MonitorDailyCell['rag_mode'],
    channel: row.channel as MonitorDailyCell['channel'],
    doc_type: row.doc_type,
    retrievals: row.retrievals,
    refused: row.refused,
    kb_unavailable: row.kb_unavailable,
    degraded: row.degraded,
    error: row.error,
    zero_result: row.zero_result,
    below_threshold: row.below_threshold,
    helpful: row.helpful,
    not_helpful: row.not_helpful,
    judged: row.judged,
    groundedness_flagged: row.groundedness_flagged,
    judge_score_sums: sums,
    top_score_hist: topScoreHist(row.top_score_hist),
    latency_hist: latencyHist(row.latency_hist),
  };
}

async function readCells(admin: SupabaseClient, from: string, to: string): Promise<MonitorDailyCell[]> {
  const out: MonitorDailyCell[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from('rag_monitor_daily')
      .select('*')
      .gte('day', from)
      .lte('day', to)
      .order('tenant_key')
      .order('day')
      .order('language')
      .order('rag_mode')
      .order('channel')
      .order('doc_type')
      .range(offset, offset + PAGE - 1);
    if (error) throw new MonitorRunError('read_daily_cells', codeOf(error));
    const rows = (data ?? []) as DailyRow[];
    out.push(...rows.map(toDailyCell));
    if (rows.length < PAGE) return out;
  }
}

async function daysToAggregate(admin: SupabaseClient, day: string): Promise<string[]> {
  const { data, error } = await admin.rpc('rag_monitor_days_to_aggregate', { p_trailing: TRAILING_DAYS });
  if (error) throw new MonitorRunError('rag_monitor_days_to_aggregate', codeOf(error));
  const days = new Set(((data ?? []) as unknown[]).map((value) => String(value).slice(0, 10)));
  days.add(day);
  return [...days].filter((d) => d <= day).sort();
}

function budgetsFromConfig(): LatencyBudgets | null {
  const parsed = LatencyBudgetsSchema.safeParse(budgetsJson);
  return parsed.success ? parsed.data : null;
}

function channelsFor(webhookUrl: string | null): DeliveryChannel[] {
  return webhookUrl ? ['webhook'] : [];
}

/**
 * The daily monitor run (D-20 to D-27). Aggregates every day rag_monitor_days_to_aggregate returns (and the evaluation day),
 * evaluates the configured rules over the window and baseline cells of every tenant, then the context-input rules of the
 * registry (the LANG-10 hook), attaches sample trace ids and the configuration changes of each alert's window, and upserts
 * one open alert per dedup key. Purges cells and run rows older than 400 days and records the run. With RAG_MONITOR off it
 * reads and writes nothing; with the retrieval log off it writes nothing. Logs carry counts, rule ids and kinds only.
 */
export async function runDaily(admin: SupabaseClient, options: RunDailyOptions): Promise<RunDailyResult> {
  const settings = options.env ? monitorSettings(options.env) : monitorSettings();
  if (!settings.monitor) return { ran: false, reason: 'switched_off' };
  const logLevel = readFeedbackLoopConfig(options.env ?? process.env, () => undefined).retrievalLog;
  if (logLevel === 'off') {
    console.info('[Monitor] the retrieval log is off; nothing to monitor');
    return { ran: false, reason: 'log_off' };
  }
  const config = options.config ?? loadMonitorAlertsConfig();
  if (!config) return { ran: false, reason: 'config_invalid' };
  const budgets = options.budgets !== undefined ? options.budgets : budgetsFromConfig();

  const now = options.now ?? new Date();
  const day = options.day ?? addDays(utcDay(now), -1);

  const days = await daysToAggregate(admin, day);
  for (const d of days) {
    const { error } = await admin.rpc('rag_monitor_aggregate', { p_day: d });
    if (error) throw new MonitorRunError('rag_monitor_aggregate', codeOf(error));
  }

  const cells = await readCells(admin, addDays(day, -(config.baseline_days + TRAILING_DAYS)), day);
  const evaluated = evaluateRules({ cells, day, config, budgets, registry: options.registry });
  const candidates: AlertCandidate[] = [...evaluated.candidates];
  const tenantKeys = [...new Set(cells.map((cell) => cell.tenant_key))].sort();

  const contextRulesFailed: string[] = [];
  for (const { rule, entry } of evaluated.contextRules) {
    const ctx: RuleContext = {
      admin,
      rule,
      day,
      windowDays: config.window_days,
      baselineDays: config.baseline_days,
      tenantKeys,
    };
    try {
      candidates.push(...(await entry.evaluate(rule, ctx)));
    } catch {
      contextRulesFailed.push(rule.id);
      console.warn('[Monitor] context rule failed; skipped', { kind: rule.kind, rule: rule.id });
    }
  }

  const inputs: UpsertAlertInput[] = [];
  const channels = channelsFor(settings.webhookUrl);
  for (const candidate of candidates) {
    const from = `${addDays(candidate.day, -(candidate.window_days - 1))}T00:00:00.000Z`;
    const to = `${addDays(candidate.day, 1)}T00:00:00.000Z`;
    const evidence = await windowConfigChanges(admin, {
      tenantKey: candidate.tenant_key,
      language: candidate.language,
      from,
      to,
      match: matchForRule(candidate.rule),
    });
    inputs.push({
      candidate,
      evidence: { sampleTraceIds: evidence.sampleTraceIds, configChanges: evidence.configChanges },
      channels,
    });
  }
  const stored = await upsertAlerts(admin, inputs, now);

  const purge = await admin.rpc('rag_monitor_purge', { p_keep_days: KEEP_DAYS });
  if (purge.error) throw new MonitorRunError('rag_monitor_purge', codeOf(purge.error));
  await purgeRuns(admin, now, KEEP_DAYS);

  await recordRun(admin, {
    day,
    source: options.source,
    daysAggregated: days.length,
    groupsChecked: evaluated.groupsChecked,
    groupsInsufficient: evaluated.groupsInsufficient,
    alertsOpened: stored.opened,
    alertsUpdated: stored.updated,
    deliveries: stored.deliveries,
  });

  const result: RunDailyResult = {
    ran: true,
    day,
    daysAggregated: days.length,
    cellsRead: cells.length,
    groupsChecked: evaluated.groupsChecked,
    groupsInsufficient: evaluated.groupsInsufficient,
    candidates: candidates.length,
    alertsOpened: stored.opened,
    alertsUpdated: stored.updated,
    alertsSuppressed: stored.suppressed,
    alertsInvalid: stored.invalid,
    deliveries: stored.deliveries,
    rulesUnregistered: evaluated.rulesUnregistered,
    contextRulesFailed,
  };
  console.info('[Monitor] daily run finished', {
    day,
    days_aggregated: result.daysAggregated,
    groups_checked: result.groupsChecked,
    groups_insufficient: result.groupsInsufficient,
    alerts_opened: result.alertsOpened,
    alerts_updated: result.alertsUpdated,
    alerts_suppressed: result.alertsSuppressed,
    alert_ids: stored.ids,
  });
  return result;
}
