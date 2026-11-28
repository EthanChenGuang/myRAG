import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LanguageDropAlertSchema,
  LanguageQualityCellSchema,
  type LanguageDropAlert,
  type LanguageQualityCell,
} from '@/lib/rag-eval/contracts.generated';
import type { AlertCandidate, MonitorRule, RuleContext } from './rule-registry';
import { addDays } from './rule-kinds';
import { dedupKey } from './rules';

/** LANG-10: the rule id and kind of the per-language drop rule in eval/config/monitor-alerts.json. */
export const LANGUAGE_DROP_RULE_ID = 'language_drop';

export type LanguageCountMetric = LanguageDropAlert['metric'];
export const LANGUAGE_COUNT_METRICS: readonly LanguageCountMetric[] = [
  'refusal_rate',
  'not_helpful_rate',
  'kb_unavailable_rate',
  'low_confidence_rate',
];
/** The online judge mean (a mean of scores, not a count), measured from the job's daily cells. */
export const LANGUAGE_JUDGE_METRIC = 'judge_mean';
export type LanguageDropMetric = LanguageCountMetric | typeof LANGUAGE_JUDGE_METRIC;

const UNDETERMINED = 'und';
const MAX_SAMPLE_TRACE_IDS = 10;
const EPSILON = 1e-9;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LanguageDropBand {
  /** The worsening of one language against its own baseline beyond which it drops. */
  language: number;
  /** The worsening of the overall average within which the average holds. */
  overall: number;
}

/** The parsed language_drop rule: metrics, sample floors and one band pair per metric. */
export interface LanguageDropRule {
  id: string;
  metrics: LanguageDropMetric[];
  minSample: number;
  baselineMinSample: number;
  bands: Partial<Record<LanguageDropMetric, LanguageDropBand>>;
  /** Days of the evaluation window ending on the job's day; null uses the job's first window. */
  windowDays: number | null;
  /** Passed to rag_language_quality_cells: rows below it count under und and as low confidence. */
  minConfidence: number | null;
}

interface Window {
  since: string;
  until: string;
}

export interface EvaluateLanguageDropInput {
  current: readonly LanguageQualityCell[];
  baseline: readonly LanguageQualityCell[];
  rule: LanguageDropRule;
  /** Optional sample trace ids per language (at most ten are kept); ids only. */
  samples?: Readonly<Record<string, readonly string[]>>;
}

interface CountOverN {
  count: number;
  n: number;
}

function measure(metric: LanguageCountMetric, cell: LanguageQualityCell): CountOverN {
  switch (metric) {
    case 'refusal_rate':
      return { count: cell.refused, n: cell.retrievals };
    case 'kb_unavailable_rate':
      return { count: cell.kb_unavailable, n: cell.retrievals };
    case 'low_confidence_rate':
      return { count: cell.low_confidence, n: cell.retrievals };
    case 'not_helpful_rate':
      return { count: cell.votes_down, n: cell.votes_up + cell.votes_down };
  }
}

function sum(cells: readonly LanguageQualityCell[], metric: LanguageCountMetric): CountOverN {
  let count = 0;
  let n = 0;
  for (const cell of cells) {
    const value = measure(metric, cell);
    count += value.count;
    n += value.n;
  }
  return { count, n };
}

function rate(value: CountOverN): number | null {
  return value.n > 0 ? value.count / value.n : null;
}

function groupKey(tenantKey: string | null | undefined): string {
  return tenantKey ?? '';
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function windowOf(cells: readonly LanguageQualityCell[]): Window | null {
  const first = cells[0];
  return first ? { since: first.window.since, until: first.window.until } : null;
}

function sampleIds(samples: EvaluateLanguageDropInput['samples'], language: string): string[] {
  const ids = samples?.[language] ?? [];
  return [...new Set(ids)].slice(0, MAX_SAMPLE_TRACE_IDS);
}

/**
 * LANG-10 (pure): one alert per (tenant group, language, count metric) where the language's rate worsened beyond the language
 * band against its own baseline while the overall rate of the group (every language, und included) worsened by no more than the
 * overall band. A language needs the minimum sample in both windows; und is never alerted. Ids and counts only.
 */
export function evaluateLanguageDrop(input: EvaluateLanguageDropInput): LanguageDropAlert[] {
  const { rule } = input;
  const window = windowOf(input.current);
  if (!window) return [];
  const metrics = rule.metrics.filter((metric): metric is LanguageCountMetric =>
    (LANGUAGE_COUNT_METRICS as readonly string[]).includes(metric),
  );
  const currentGroups = groupBy(input.current, (cell) => groupKey(cell.tenant_key));
  const baselineGroups = groupBy(input.baseline, (cell) => groupKey(cell.tenant_key));
  const alerts: LanguageDropAlert[] = [];

  for (const group of [...currentGroups.keys()].sort()) {
    const current = currentGroups.get(group) ?? [];
    const baseline = baselineGroups.get(group) ?? [];
    const tenantKey = current[0]?.tenant_key ?? null;
    const currentByLanguage = groupBy(current, (cell) => cell.language);
    const baselineByLanguage = groupBy(baseline, (cell) => cell.language);

    for (const metric of metrics) {
      const band = rule.bands[metric];
      if (!band) continue;
      const overallNow = rate(sum(current, metric));
      const overallBefore = rate(sum(baseline, metric));
      if (overallNow === null || overallBefore === null) continue;
      if (overallNow - overallBefore > band.overall + EPSILON) continue;

      for (const language of [...currentByLanguage.keys()].sort()) {
        if (language === UNDETERMINED) continue;
        const now = sum(currentByLanguage.get(language) ?? [], metric);
        const before = sum(baselineByLanguage.get(language) ?? [], metric);
        if (now.n < rule.minSample || before.n < rule.baselineMinSample) continue;
        const delta = (rate(now) as number) - (rate(before) as number);
        if (delta <= band.language + EPSILON) continue;
        alerts.push(
          LanguageDropAlertSchema.parse({
            rule_id: rule.id,
            metric,
            language,
            tenant_key: tenantKey,
            events: now.count,
            total: now.n,
            baseline_events: before.count,
            baseline_total: before.n,
            window,
            sample_trace_ids: sampleIds(input.samples, language),
          }),
        );
      }
    }
  }
  return alerts;
}

/** One (tenant, language) group of the job's daily cells: judged answers and the sum of each judge metric's score. */
export interface LanguageJudgeCell {
  tenant_key: string | null;
  language: string;
  judged: number;
  score_sums: Readonly<Record<string, number>>;
}

/** A judge-mean drop of one language while the overall judge mean holds; numbers and codes only. */
export interface LanguageJudgeDrop {
  rule_id: string;
  metric: typeof LANGUAGE_JUDGE_METRIC;
  language: string;
  tenant_key: string | null;
  n: number;
  mean: number;
  baseline_n: number;
  baseline_mean: number;
  overall_mean: number;
  overall_baseline_mean: number;
}

function judgeMean(cells: readonly LanguageJudgeCell[], metrics: readonly string[]): { n: number; mean: number | null } {
  const n = cells.reduce((total, cell) => total + cell.judged, 0);
  if (n <= 0 || metrics.length === 0) return { n, mean: null };
  let total = 0;
  for (const metric of metrics) total += cells.reduce((s, cell) => s + (cell.score_sums[metric] ?? 0), 0) / n;
  return { n, mean: total / metrics.length };
}

function judgeMetricsOf(cells: readonly LanguageJudgeCell[]): Set<string> {
  const out = new Set<string>();
  for (const cell of cells) for (const metric of Object.keys(cell.score_sums)) out.add(metric);
  return out;
}

/**
 * LANG-10 (pure), the judge-score half: a language whose mean judge score (over the metrics present in both windows) fell by more
 * than the language band while the group's overall mean fell by no more than the overall band.
 */
export function evaluateLanguageJudgeDrop(input: {
  current: readonly LanguageJudgeCell[];
  baseline: readonly LanguageJudgeCell[];
  rule: LanguageDropRule;
}): LanguageJudgeDrop[] {
  const { rule } = input;
  const band = rule.bands[LANGUAGE_JUDGE_METRIC];
  if (!rule.metrics.includes(LANGUAGE_JUDGE_METRIC) || !band) return [];
  const currentGroups = groupBy(input.current, (cell) => groupKey(cell.tenant_key));
  const baselineGroups = groupBy(input.baseline, (cell) => groupKey(cell.tenant_key));
  const drops: LanguageJudgeDrop[] = [];

  for (const group of [...currentGroups.keys()].sort()) {
    const current = currentGroups.get(group) ?? [];
    const baseline = baselineGroups.get(group) ?? [];
    const windowMetrics = judgeMetricsOf(current);
    const metrics = [...judgeMetricsOf(baseline)].filter((metric) => windowMetrics.has(metric)).sort();
    const overallNow = judgeMean(current, metrics);
    const overallBefore = judgeMean(baseline, metrics);
    if (overallNow.mean === null || overallBefore.mean === null) continue;
    if (overallBefore.mean - overallNow.mean > band.overall + EPSILON) continue;
    const currentByLanguage = groupBy(current, (cell) => cell.language);
    const baselineByLanguage = groupBy(baseline, (cell) => cell.language);
    for (const language of [...currentByLanguage.keys()].sort()) {
      if (language === UNDETERMINED) continue;
      const now = judgeMean(currentByLanguage.get(language) ?? [], metrics);
      const before = judgeMean(baselineByLanguage.get(language) ?? [], metrics);
      if (now.mean === null || before.mean === null) continue;
      if (now.n < rule.minSample || before.n < rule.baselineMinSample) continue;
      if (before.mean - now.mean <= band.language + EPSILON) continue;
      drops.push({
        rule_id: rule.id,
        metric: LANGUAGE_JUDGE_METRIC,
        language,
        tenant_key: current[0]?.tenant_key ?? null,
        n: now.n,
        mean: now.mean,
        baseline_n: before.n,
        baseline_mean: before.mean,
        overall_mean: overallNow.mean,
        overall_baseline_mean: overallBefore.mean,
      });
    }
  }
  return drops;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The language_drop rule of eval/config/monitor-alerts.json as a LanguageDropRule; null when its params are unusable. */
export function languageDropRuleOf(rule: MonitorRule): LanguageDropRule | null {
  const params = rule.params ?? {};
  const listed = Array.isArray(params.metrics) ? params.metrics : [];
  const known = [...LANGUAGE_COUNT_METRICS, LANGUAGE_JUDGE_METRIC] as readonly string[];
  const metrics = listed.filter((metric): metric is LanguageDropMetric => known.includes(metric));
  if (metrics.length === 0 || metrics.length !== listed.length) return null;
  const bands: LanguageDropRule['bands'] = {};
  for (const metric of metrics) {
    const language = positive(params[`language_band_${metric}`]);
    const overall = positive(params[`overall_band_${metric}`]);
    if (language === null || overall === null) return null;
    bands[metric] = { language, overall };
  }
  const windowDays = params.window_days;
  if (windowDays !== undefined && !(typeof windowDays === 'number' && Number.isInteger(windowDays) && windowDays >= 1)) return null;
  const minConfidence = params.min_confidence;
  if (minConfidence !== undefined && !(typeof minConfidence === 'number' && minConfidence >= 0 && minConfidence <= 1)) return null;
  return {
    id: rule.id,
    metrics,
    minSample: rule.min_sample,
    baselineMinSample: rule.baseline_min_sample ?? rule.min_sample,
    bands,
    windowDays: typeof windowDays === 'number' ? windowDays : null,
    minConfidence: typeof minConfidence === 'number' ? minConfidence : null,
  };
}

/** A rag_language_quality_cells row (0743). */
export interface LanguageQualityCellRow {
  tenant_key: string;
  language: string;
  retrievals: number | string;
  refused: number | string;
  kb_unavailable: number | string;
  votes_up: number | string;
  votes_down: number | string;
  low_confidence: number | string;
}

function count(value: number | string): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * 0743 rows as LanguageQualityCell contracts. `pooled` sums the tenants of each language into one cell with tenant_key null
 * (all tenants); otherwise one cell per (tenant, language). A row that fails the contract is dropped.
 */
export function toLanguageQualityCells(
  rows: readonly LanguageQualityCellRow[],
  window: Window,
  options: { pooled?: boolean } = {},
): LanguageQualityCell[] {
  const merged = new Map<string, LanguageQualityCell>();
  for (const row of rows) {
    const tenantKey = options.pooled ? null : row.tenant_key;
    const key = `${tenantKey ?? ''}|${row.language}`;
    const previous = merged.get(key);
    const next = {
      tenant_key: tenantKey,
      language: row.language,
      window: { since: window.since, until: window.until },
      retrievals: (previous?.retrievals ?? 0) + count(row.retrievals),
      refused: (previous?.refused ?? 0) + count(row.refused),
      kb_unavailable: (previous?.kb_unavailable ?? 0) + count(row.kb_unavailable),
      votes_up: (previous?.votes_up ?? 0) + count(row.votes_up),
      votes_down: (previous?.votes_down ?? 0) + count(row.votes_down),
      low_confidence: (previous?.low_confidence ?? 0) + count(row.low_confidence),
    };
    merged.set(key, next);
  }
  const out: LanguageQualityCell[] = [];
  for (const key of [...merged.keys()].sort()) {
    const parsed = LanguageQualityCellSchema.safeParse(merged.get(key));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export class LanguageQualityReadError extends Error {
  constructor(readonly code: string | null) {
    super(`[Monitor] rag_language_quality_cells failed${code ? ` (${code})` : ''}`);
    this.name = 'LanguageQualityReadError';
  }
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Reads the cells of [since, until] (UTC days, inclusive) for the given tenants through 0743. */
export async function readLanguageQualityCells(
  admin: SupabaseClient,
  input: { window: Window; tenantKeys: readonly string[] | null; minConfidence?: number | null; pooled?: boolean },
): Promise<LanguageQualityCell[]> {
  if (!DAY_RE.test(input.window.since) || !DAY_RE.test(input.window.until)) throw new LanguageQualityReadError('22023');
  const { data, error } = await admin.rpc('rag_language_quality_cells', {
    p_since: `${input.window.since}T00:00:00.000Z`,
    p_until: `${addDays(input.window.until, 1)}T00:00:00.000Z`,
    p_tenant_keys: input.tenantKeys === null ? null : [...input.tenantKeys],
    p_min_confidence: input.minConfidence ?? null,
  });
  if (error) throw new LanguageQualityReadError(codeOf(error));
  return toLanguageQualityCells((data ?? []) as LanguageQualityCellRow[], input.window, { pooled: input.pooled });
}

interface DailyJudgeRow {
  tenant_key: string;
  language: string;
  judged: number | string;
  judge_score_sums: Record<string, number | string> | null;
}

/** The judged answers and judge score sums of the job's daily cells (rag_monitor_daily) per (tenant, language) over a window. */
export async function readLanguageJudgeCells(
  admin: SupabaseClient,
  input: { window: Window; tenantKeys: readonly string[] },
): Promise<LanguageJudgeCell[]> {
  if (input.tenantKeys.length === 0) return [];
  const { data, error } = await admin
    .from('rag_monitor_daily')
    .select('tenant_key, language, judged, judge_score_sums')
    .in('tenant_key', [...input.tenantKeys])
    .gte('day', input.window.since)
    .lte('day', input.window.until);
  if (error) throw new LanguageQualityReadError(codeOf(error));
  const merged = new Map<string, LanguageJudgeCell>();
  for (const row of (data ?? []) as DailyJudgeRow[]) {
    const key = `${row.tenant_key}|${row.language}`;
    const cell = merged.get(key) ?? { tenant_key: row.tenant_key, language: row.language, judged: 0, score_sums: {} };
    const sums: Record<string, number> = { ...cell.score_sums };
    for (const [metric, value] of Object.entries(row.judge_score_sums ?? {})) sums[metric] = (sums[metric] ?? 0) + (Number(value) || 0);
    merged.set(key, { ...cell, judged: cell.judged + count(row.judged), score_sums: sums });
  }
  return [...merged.values()];
}

/** The judge means per language of a set of judge cells (route output): mean over the metrics, n judged answers. */
export function judgeMeansByLanguage(cells: readonly LanguageJudgeCell[]): Record<string, { n: number; mean: number | null }> {
  const metrics = [...judgeMetricsOf(cells)].sort();
  const out: Record<string, { n: number; mean: number | null }> = {};
  const byLanguage = groupBy(cells, (cell) => cell.language);
  for (const language of [...byLanguage.keys()].sort()) out[language] = judgeMean(byLanguage.get(language) ?? [], metrics);
  return out;
}

function windowsFor(day: string, windowDays: number, baselineDays: number): { current: Window; baseline: Window } {
  const since = addDays(day, -(windowDays - 1));
  const baselineUntil = addDays(since, -1);
  return {
    current: { since, until: day },
    baseline: { since: addDays(baselineUntil, -(baselineDays - 1)), until: baselineUntil },
  };
}

function countCandidate(alert: LanguageDropAlert, rule: LanguageDropRule, ctx: RuleContext, windowDays: number): AlertCandidate {
  const band = rule.bands[alert.metric] as LanguageDropBand;
  const value = alert.total > 0 ? alert.events / alert.total : null;
  const baseline = alert.baseline_total > 0 ? alert.baseline_events / alert.baseline_total : null;
  return {
    tenant_key: alert.tenant_key as string,
    rule: LANGUAGE_DROP_RULE_ID,
    kind: 'language_drop',
    language: alert.language,
    day: ctx.day,
    window_days: windowDays,
    severity: 'alert',
    observed: { count: alert.events, n: alert.total, value },
    baseline: { count: alert.baseline_events, n: alert.baseline_total, value: baseline },
    band: {
      min_abs_delta: band.language,
      measured_delta: value !== null && baseline !== null ? value - baseline : null,
      measured_value: value,
    },
    breakdown: {},
    companions: [],
    cluster_ids: [],
    suggestion: null,
    dedup_key: dedupKey(alert.tenant_key as string, alert.language, `${rule.id}|${alert.metric}`),
  };
}

function judgeCandidate(drop: LanguageJudgeDrop, rule: LanguageDropRule, ctx: RuleContext, windowDays: number): AlertCandidate {
  const band = rule.bands[LANGUAGE_JUDGE_METRIC] as LanguageDropBand;
  return {
    tenant_key: drop.tenant_key as string,
    rule: LANGUAGE_DROP_RULE_ID,
    kind: 'language_drop',
    language: drop.language,
    day: ctx.day,
    window_days: windowDays,
    severity: 'alert',
    observed: { n: drop.n, value: drop.mean },
    baseline: { n: drop.baseline_n, value: drop.baseline_mean },
    band: { drop: band.language, measured_delta: drop.mean - drop.baseline_mean, measured_value: drop.mean },
    breakdown: {},
    companions: [],
    cluster_ids: [],
    suggestion: null,
    dedup_key: dedupKey(drop.tenant_key as string, drop.language, `${rule.id}|${LANGUAGE_JUDGE_METRIC}`),
  };
}

/**
 * The OBS-03 context entry of the language_drop kind: reads the window and trailing-baseline cells of every tenant the job saw
 * through rag_language_quality_cells (and, for judge_mean, the job's daily cells), evaluates each tenant on its own and returns the
 * alert candidates; the job attaches sample trace ids and configuration changes and delivers them through its channels.
 */
export async function evaluateLanguageDropRule(monitorRule: MonitorRule, ctx: RuleContext): Promise<AlertCandidate[]> {
  const rule = languageDropRuleOf(monitorRule);
  if (!rule) {
    console.warn('[Monitor] language_drop rule params are unusable; skipped', { rule: monitorRule.id });
    return [];
  }
  if (ctx.tenantKeys.length === 0) return [];
  const windowDays = rule.windowDays ?? ctx.windowDays[0] ?? 1;
  const windows = windowsFor(ctx.day, windowDays, ctx.baselineDays);
  const candidates: AlertCandidate[] = [];

  if (rule.metrics.some((metric) => metric !== LANGUAGE_JUDGE_METRIC)) {
    const read = (window: Window) =>
      readLanguageQualityCells(ctx.admin, { window, tenantKeys: ctx.tenantKeys, minConfidence: rule.minConfidence });
    const [current, baseline] = [await read(windows.current), await read(windows.baseline)];
    for (const alert of evaluateLanguageDrop({ current, baseline, rule })) {
      if (alert.tenant_key) candidates.push(countCandidate(alert, rule, ctx, windowDays));
    }
  }
  if (rule.metrics.includes(LANGUAGE_JUDGE_METRIC)) {
    const read = (window: Window) => readLanguageJudgeCells(ctx.admin, { window, tenantKeys: ctx.tenantKeys });
    const [current, baseline] = [await read(windows.current), await read(windows.baseline)];
    for (const drop of evaluateLanguageJudgeDrop({ current, baseline, rule })) {
      if (drop.tenant_key) candidates.push(judgeCandidate(drop, rule, ctx, windowDays));
    }
  }
  return candidates;
}

/** At most this many days per admin language-quality read (T-07-154). */
export const MAX_LANGUAGE_QUALITY_DAYS = 90;

export type LanguageQualityReport =
  | {
      ok: true;
      cells: LanguageQualityCell[];
      /** Judge score means per language from the job's daily cells; null when no answer of the window was judged. */
      judge: Record<string, { n: number; mean: number | null }> | null;
    }
  | { ok: false; reason: 'forbidden' | 'unavailable' };

/**
 * LANG-10 admin read: the cells of the tenants the admin administers (resolved in SQL by rag_admin_tenant_keys), optionally a
 * subset of them, pooled per language or per (tenant, language), plus the judge means per language. Counts and codes only.
 */
export async function languageQualityForAdmin(
  admin: SupabaseClient,
  input: { actorUserId: string; window: Window; tenants: readonly string[] | null; byTenant: boolean },
): Promise<LanguageQualityReport> {
  const { data, error } = await admin.rpc('rag_admin_tenant_keys', { p_actor: input.actorUserId.toLowerCase() });
  if (error || !Array.isArray(data)) return { ok: false, reason: 'unavailable' };
  const administered = new Set(data.filter((key): key is string => typeof key === 'string'));
  if (input.tenants && input.tenants.some((key) => !administered.has(key))) return { ok: false, reason: 'forbidden' };
  const keys = [...(input.tenants ?? administered)].sort();
  if (keys.length === 0) return { ok: true, cells: [], judge: null };
  try {
    const cells = await readLanguageQualityCells(admin, { window: input.window, tenantKeys: keys, pooled: !input.byTenant });
    const judgeCells = await readLanguageJudgeCells(admin, { window: input.window, tenantKeys: keys });
    const judged = judgeCells.some((cell) => cell.judged > 0);
    return { ok: true, cells, judge: judged ? judgeMeansByLanguage(judgeCells) : null };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
