import type { MonitorDailyCell } from '@/lib/rag-eval/contracts.generated';
import type { AlertCandidate, DailyCellsContext, DayRange, GroupOutcome, MonitorRule, RuleFinding } from './rule-registry';
import { histogramQuantile, mergeBins, psi, twoProportionZ, type CountOverN } from './stats';

type Measure = AlertCandidate['observed'];
type Breakdown = AlertCandidate['breakdown'];
type ScoreKind = 'rerank' | 'similarity';

const SCORE_KINDS: readonly ScoreKind[] = ['rerank', 'similarity'];
const DEFAULT_MERGED_BINS = 10;
const EPSILON = 1e-9;

/** Numerator and denominator of each rate metric of a daily cell (D-24). */
export const RATE_METRICS: Readonly<Record<string, (cell: MonitorDailyCell) => CountOverN>> = {
  refusal_rate: (c) => ({ count: c.refused, n: c.retrievals }),
  zero_result_rate: (c) => ({ count: c.zero_result, n: c.retrievals }),
  below_threshold_rate: (c) => ({ count: c.below_threshold, n: c.retrievals }),
  not_helpful_rate: (c) => ({ count: c.not_helpful, n: c.helpful + c.not_helpful }),
  groundedness_flagged_rate: (c) => ({ count: c.groundedness_flagged, n: c.retrievals }),
  kb_error_rate: (c) => ({ count: c.error, n: c.retrievals }),
  kb_degraded_rate: (c) => ({ count: c.degraded, n: c.retrievals }),
  kb_unavailable_rate: (c) => ({ count: c.kb_unavailable, n: c.retrievals }),
};

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function cellsIn(cells: readonly MonitorDailyCell[], range: DayRange): MonitorDailyCell[] {
  return cells.filter((cell) => cell.day >= range.from && cell.day <= range.to);
}

export function baselineRangeFor(window: DayRange, baselineDays: number): DayRange {
  const to = addDays(window.from, -1);
  return { from: addDays(to, -(baselineDays - 1)), to };
}

interface ChosenWindow {
  days: number;
  range: DayRange;
  cells: MonitorDailyCell[];
}

/** The first window of config.window_days (1, 3, 7) holding at least minSample rows; null when none does. */
export function chooseWindow(
  cells: readonly MonitorDailyCell[],
  ctx: DailyCellsContext,
  minSample: number,
  size: (cells: readonly MonitorDailyCell[]) => number,
): ChosenWindow | null {
  for (const days of ctx.config.window_days) {
    const range = { from: addDays(ctx.day, -(days - 1)), to: ctx.day };
    const inWindow = cellsIn(cells, range);
    if (size(inWindow) >= minSample) return { days, range, cells: inWindow };
  }
  return null;
}

export function sumMetric(cells: readonly MonitorDailyCell[], metric: (cell: MonitorDailyCell) => CountOverN): CountOverN {
  let count = 0;
  let n = 0;
  for (const cell of cells) {
    const value = metric(cell);
    count += value.count;
    n += value.n;
  }
  return { count, n };
}

function atLeast(value: number, limit: number): boolean {
  return value >= limit - EPSILON;
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function rateOf(value: CountOverN): number | null {
  return value.n > 0 ? value.count / value.n : null;
}

/** Breakdown of the window rows by mode, channel and document type, each measured by `measure`. */
function breakdownOf(cells: readonly MonitorDailyCell[], measure: (cells: MonitorDailyCell[]) => Measure): Breakdown {
  const group = <K extends string>(key: (cell: MonitorDailyCell) => K): Partial<Record<K, Measure>> => {
    const buckets = new Map<K, MonitorDailyCell[]>();
    for (const cell of cells) {
      const k = key(cell);
      const list = buckets.get(k);
      if (list) list.push(cell);
      else buckets.set(k, [cell]);
    }
    const out: Partial<Record<K, Measure>> = {};
    for (const k of [...buckets.keys()].sort()) out[k] = measure(buckets.get(k) as MonitorDailyCell[]);
    return out;
  };
  return {
    by_mode: group((cell) => cell.rag_mode),
    by_channel: group((cell) => cell.channel),
    by_doc_type: group((cell) => cell.doc_type),
  } as Breakdown;
}

export function evaluateRate(rule: MonitorRule, cells: readonly MonitorDailyCell[], ctx: DailyCellsContext): GroupOutcome {
  const metric = rule.metric ? RATE_METRICS[rule.metric] : undefined;
  if (!metric || rule.ratio == null || rule.min_abs_delta == null || rule.min_z == null || rule.baseline_min_sample == null) {
    return { status: 'insufficient_sample' };
  }
  const window = chooseWindow(cells, ctx, rule.min_sample, (rows) => sumMetric(rows, metric).n);
  if (!window) return { status: 'insufficient_sample' };
  const baselineRange = baselineRangeFor(window.range, ctx.config.baseline_days);
  const observed = sumMetric(window.cells, metric);
  const baseline = sumMetric(cellsIn(cells, baselineRange), metric);
  if (baseline.n < rule.baseline_min_sample) return { status: 'insufficient_sample' };

  const p1 = observed.count / observed.n;
  const p2 = baseline.count / baseline.n;
  const ratio = p2 > 0 ? p1 / p2 : p1 > 0 ? Number.POSITIVE_INFINITY : 0;
  const delta = p1 - p2;
  const z = twoProportionZ(observed.count, observed.n, baseline.count, baseline.n);
  const crossed = atLeast(ratio, rule.ratio) && atLeast(delta, rule.min_abs_delta) && z !== null && atLeast(z, rule.min_z);
  if (!crossed) return { status: 'within_band' };

  return {
    status: 'crossed',
    finding: {
      severity: 'alert',
      window_days: window.days,
      windowRange: window.range,
      baselineRange,
      observed: { count: observed.count, n: observed.n, value: p1 },
      baseline: { count: baseline.count, n: baseline.n, value: p2 },
      band: {
        ratio: rule.ratio,
        min_abs_delta: rule.min_abs_delta,
        min_z: rule.min_z,
        measured_ratio: finite(ratio),
        measured_delta: delta,
        measured_z: z,
      },
      breakdown: breakdownOf(window.cells, (rows) => {
        const value = sumMetric(rows, metric);
        return { count: value.count, n: value.n, value: rateOf(value) };
      }),
    },
  };
}

function scoreKinds(rule: MonitorRule): ScoreKind[] {
  const configured = rule.params?.score_kinds;
  if (Array.isArray(configured)) return SCORE_KINDS.filter((kind) => configured.includes(kind));
  return [...SCORE_KINDS];
}

function scoreTotal(cells: readonly MonitorDailyCell[], kind: ScoreKind): number {
  let total = 0;
  for (const cell of cells) {
    const h = cell.top_score_hist?.[kind];
    if (h) total += h.bins.reduce((a, b) => a + b, 0) + (h.underflow ?? 0) + (h.overflow ?? 0);
  }
  return total;
}

function scoreShares(cells: readonly MonitorDailyCell[], kind: ScoreKind, merged: number): number[] | null {
  let sum: { bins: number[]; underflow: number; overflow: number } | null = null;
  for (const cell of cells) {
    const h = cell.top_score_hist?.[kind];
    if (!h) continue;
    if (!sum) sum = { bins: new Array<number>(h.bins.length).fill(0), underflow: 0, overflow: 0 };
    h.bins.forEach((value, i) => {
      (sum as { bins: number[] }).bins[i] += value;
    });
    sum.underflow += h.underflow ?? 0;
    sum.overflow += h.overflow ?? 0;
  }
  if (!sum) return null;
  const m = mergeBins(sum, merged);
  return [m.underflow, ...m.bins, m.overflow];
}

export function evaluateDistribution(
  rule: MonitorRule,
  cells: readonly MonitorDailyCell[],
  ctx: DailyCellsContext,
): GroupOutcome {
  if (rule.warn == null || rule.alert == null || rule.baseline_min_sample == null) return { status: 'insufficient_sample' };
  const mergedParam = rule.params?.merged_bins;
  const merged = typeof mergedParam === 'number' ? mergedParam : DEFAULT_MERGED_BINS;
  let sufficient = false;
  let worst: RuleFinding | null = null;
  for (const kind of scoreKinds(rule)) {
    const window = chooseWindow(cells, ctx, rule.min_sample, (rows) => scoreTotal(rows, kind));
    if (!window) continue;
    const baselineRange = baselineRangeFor(window.range, ctx.config.baseline_days);
    const baselineCells = cellsIn(cells, baselineRange);
    const baselineN = scoreTotal(baselineCells, kind);
    if (baselineN < rule.baseline_min_sample) continue;
    const actual = scoreShares(window.cells, kind, merged);
    const expected = scoreShares(baselineCells, kind, merged);
    if (!actual || !expected) continue;
    sufficient = true;
    const value = psi(actual, expected);
    if (!atLeast(value, rule.warn)) continue;
    if (worst && (worst.band.measured_value ?? 0) >= value) continue;
    const severity = atLeast(value, rule.alert) ? 'alert' : 'warning';
    worst = {
      severity,
      window_days: window.days,
      windowRange: window.range,
      baselineRange,
      observed: { n: scoreTotal(window.cells, kind), value },
      baseline: { n: baselineN, value: null },
      band: { warn: rule.warn, alert: rule.alert, measured_value: value },
      breakdown: breakdownOf(window.cells, (rows) => ({ n: scoreTotal(rows, kind) })),
      suggestion: severity === 'alert' ? 'recalibrate_refusal' : null,
    };
  }
  if (worst) return { status: 'crossed', finding: worst };
  return { status: sufficient ? 'within_band' : 'insufficient_sample' };
}

function latencyBins(cells: readonly MonitorDailyCell[]): number[] {
  const out: number[] = [];
  for (const cell of cells) {
    cell.latency_hist.bins.forEach((value, i) => {
      out[i] = (out[i] ?? 0) + value;
    });
  }
  return out;
}

function latencyRows(cells: readonly MonitorDailyCell[]): number {
  return latencyBins(cells).reduce((a, b) => a + b, 0);
}

export function evaluateLatency(rule: MonitorRule, cells: readonly MonitorDailyCell[], ctx: DailyCellsContext): GroupOutcome {
  if (rule.ratio == null || rule.baseline_min_sample == null) return { status: 'insufficient_sample' };
  const window = chooseWindow(cells, ctx, rule.min_sample, latencyRows);
  if (!window) return { status: 'insufficient_sample' };
  const baselineRange = baselineRangeFor(window.range, ctx.config.baseline_days);
  const baselineCells = cellsIn(cells, baselineRange);
  const budgetRatio = rule.budget_ratio ?? 1;

  let sufficient = false;
  let worst: { score: number; finding: RuleFinding } | null = null;
  for (const channel of [...new Set(window.cells.map((cell) => cell.channel))].sort()) {
    const channelWindow = window.cells.filter((cell) => cell.channel === channel);
    const n = latencyRows(channelWindow);
    if (n < rule.min_sample) continue;
    sufficient = true;
    const p95 = histogramQuantile(latencyBins(channelWindow), 0.95);
    if (p95 === null) continue;
    const channelBaseline = baselineCells.filter((cell) => cell.channel === channel);
    const baselineN = latencyRows(channelBaseline);
    const baselineP95 = baselineN >= rule.baseline_min_sample ? histogramQuantile(latencyBins(channelBaseline), 0.95) : null;
    const total = ctx.budgets?.profiles?.[channel]?.total_p95_ms;
    const budget = typeof total === 'number' ? total * budgetRatio : null;

    const ratio = baselineP95 && baselineP95 > 0 ? p95 / baselineP95 : null;
    const overRatio = ratio !== null && atLeast(ratio, rule.ratio);
    const overBudget = budget !== null && p95 > budget;
    if (!overRatio && !overBudget) continue;
    const score = Math.max(ratio !== null ? ratio / rule.ratio : 0, budget ? p95 / budget : 0);
    if (worst && worst.score >= score) continue;
    worst = {
      score,
      finding: {
        severity: 'alert',
        window_days: window.days,
        windowRange: window.range,
        baselineRange,
        observed: { n, value: p95 },
        baseline: baselineP95 !== null ? { n: baselineN, value: baselineP95 } : null,
        band: {
          ratio: rule.ratio,
          ...(budget !== null ? { budget } : {}),
          measured_ratio: ratio,
          measured_value: p95,
        },
        breakdown: breakdownOf(window.cells, (rows) => ({
          n: latencyRows(rows),
          value: histogramQuantile(latencyBins(rows), 0.95),
        })),
      },
    };
  }
  if (worst) return { status: 'crossed', finding: worst.finding };
  return { status: sufficient ? 'within_band' : 'insufficient_sample' };
}

function judgeMean(cells: readonly MonitorDailyCell[], metrics: readonly string[]): number | null {
  const judged = cells.reduce((sum, cell) => sum + cell.judged, 0);
  if (judged <= 0 || metrics.length === 0) return null;
  let total = 0;
  for (const metric of metrics) {
    total += cells.reduce((sum, cell) => sum + (cell.judge_score_sums?.[metric] ?? 0), 0) / judged;
  }
  return total / metrics.length;
}

function judgeMetrics(cells: readonly MonitorDailyCell[]): Set<string> {
  const out = new Set<string>();
  for (const cell of cells) for (const metric of Object.keys(cell.judge_score_sums ?? {})) out.add(metric);
  return out;
}

export function evaluateJudgeMean(
  rule: MonitorRule,
  cells: readonly MonitorDailyCell[],
  ctx: DailyCellsContext,
): GroupOutcome {
  if (rule.drop == null) return { status: 'insufficient_sample' };
  const judgedOf = (rows: readonly MonitorDailyCell[]) => rows.reduce((sum, cell) => sum + cell.judged, 0);
  const window = chooseWindow(cells, ctx, rule.min_sample, judgedOf);
  if (!window) return { status: 'insufficient_sample' };
  const baselineRange = baselineRangeFor(window.range, ctx.config.baseline_days);
  const baselineCells = cellsIn(cells, baselineRange);
  const baselineN = judgedOf(baselineCells);
  if (baselineN < (rule.baseline_min_sample ?? rule.min_sample)) return { status: 'insufficient_sample' };
  const windowMetrics = judgeMetrics(window.cells);
  const metrics = [...judgeMetrics(baselineCells)].filter((metric) => windowMetrics.has(metric)).sort();
  const observed = judgeMean(window.cells, metrics);
  const baseline = judgeMean(baselineCells, metrics);
  if (observed === null || baseline === null) return { status: 'insufficient_sample' };
  const delta = observed - baseline;
  if (!atLeast(-delta, rule.drop)) return { status: 'within_band' };
  return {
    status: 'crossed',
    finding: {
      severity: 'alert',
      window_days: window.days,
      windowRange: window.range,
      baselineRange,
      observed: { n: judgedOf(window.cells), value: observed },
      baseline: { n: baselineN, value: baseline },
      band: { drop: rule.drop, measured_delta: delta, measured_value: observed },
      breakdown: breakdownOf(window.cells, (rows) => ({ n: judgedOf(rows), value: judgeMean(rows, metrics) })),
    },
  };
}
