import { createHash } from 'node:crypto';
import type {
  DriftReport,
  LatencyBudgets,
  MonitorAlertsConfig,
  MonitorDailyCell,
} from '@/lib/rag-eval/contracts.generated';
import {
  RULE_KIND_REGISTRY,
  registryEntryFor,
  type AlertCandidate,
  type DailyCellsContext,
  type MonitorRule,
  type RuleFinding,
  type RuleKindEntry,
  type RuleKindRegistry,
} from './rule-registry';
import { cellsIn, RATE_METRICS, sumMetric } from './rule-kinds';

export type { AlertCandidate } from './rule-registry';

/** The language of a tenant-wide roll-up alert (D-25). */
export const ALL_LANGUAGES = 'all';

export interface EvaluateRulesInput {
  cells: readonly MonitorDailyCell[];
  /** The last day of the evaluation window, YYYY-MM-DD (UTC). */
  day: string;
  config: MonitorAlertsConfig;
  budgets?: LatencyBudgets | null;
  /** Defaults to RULE_KIND_REGISTRY; tests pass their own. */
  registry?: RuleKindRegistry;
}

export interface ContextRule {
  rule: MonitorRule;
  entry: Extract<RuleKindEntry, { input: 'context' }>;
}

export interface EvaluateRulesResult {
  candidates: AlertCandidate[];
  groupsChecked: number;
  groupsInsufficient: number;
  rulesUnregistered: string[];
  /** Context-input rules, evaluated asynchronously by runDaily (plan 05.3-27). */
  contextRules: ContextRule[];
}

/** One open alert per (tenant, language, rule): a later day updates it instead of adding one (D-25). */
export function dedupKey(tenantKey: string, language: string, rule: string): string {
  return createHash('sha256').update(`${tenantKey}|${language}|${rule}`, 'utf8').digest('hex');
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function companionsFor(
  rule: MonitorRule,
  finding: RuleFinding,
  cells: readonly MonitorDailyCell[],
  config: MonitorAlertsConfig,
): AlertCandidate['companions'] {
  const windowCells = cellsIn(cells, finding.windowRange);
  const baselineCells = finding.baselineRange ? cellsIn(cells, finding.baselineRange) : [];
  const out: AlertCandidate['companions'] = [];
  for (const other of config.rules) {
    if (other.id === rule.id || !other.enabled || other.kind !== 'rate' || !other.metric) continue;
    const metric = RATE_METRICS[other.metric];
    if (!metric) continue;
    const observed = sumMetric(windowCells, metric);
    const baseline = sumMetric(baselineCells, metric);
    out.push({
      rule: other.id,
      value: observed.n > 0 ? observed.count / observed.n : null,
      baseline: baseline.n > 0 ? baseline.count / baseline.n : null,
      n: observed.n,
    });
  }
  return out;
}

function toCandidate(
  rule: MonitorRule,
  finding: RuleFinding,
  ctx: DailyCellsContext,
  cells: readonly MonitorDailyCell[],
): AlertCandidate {
  return {
    tenant_key: ctx.tenantKey,
    rule: rule.id,
    kind: rule.kind,
    language: ctx.language,
    day: ctx.day,
    window_days: finding.window_days,
    severity: finding.severity,
    observed: finding.observed,
    baseline: finding.baseline,
    band: finding.band,
    breakdown: finding.breakdown,
    companions: companionsFor(rule, finding, cells, ctx.config),
    cluster_ids: [],
    suggestion: finding.suggestion ?? null,
    dedup_key: dedupKey(ctx.tenantKey, ctx.language, rule.id),
  };
}

/**
 * Pure rule engine over daily cells (D-24, D-25). Each configured rule is dispatched by kind through the
 * registry; rules are evaluated per (tenant, language) first, and a tenant-wide roll-up (language `all`)
 * is evaluated only when the tenant has more than one language and no single language crossed the band.
 */
export function evaluateRules(input: EvaluateRulesInput): EvaluateRulesResult {
  const { cells, day, config } = input;
  const budgets = input.budgets ?? null;
  const registry = input.registry ?? RULE_KIND_REGISTRY;
  const candidates: AlertCandidate[] = [];
  const rulesUnregistered: string[] = [];
  const contextRules: ContextRule[] = [];
  let groupsChecked = 0;
  let groupsInsufficient = 0;

  const relevant = cells.filter((cell) => cell.day <= day);
  const tenants = groupBy(relevant, (cell) => cell.tenant_key);

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const entry = registryEntryFor(rule.kind, registry);
    if (!entry) {
      if (!rulesUnregistered.includes(rule.id)) rulesUnregistered.push(rule.id);
      continue;
    }
    if (entry.input === 'report') continue;
    if (entry.input === 'context') {
      contextRules.push({ rule, entry });
      continue;
    }

    for (const [tenantKey, tenantCells] of tenants) {
      const languages = groupBy(tenantCells, (cell) => cell.language);
      let crossedAny = false;
      const run = (language: string, groupCells: readonly MonitorDailyCell[]) => {
        const ctx: DailyCellsContext = { tenantKey, language, day, config, budgets };
        groupsChecked += 1;
        const outcome = entry.evaluate(rule, groupCells, ctx);
        if (outcome.status === 'insufficient_sample') groupsInsufficient += 1;
        if (outcome.status !== 'crossed') return false;
        candidates.push(toCandidate(rule, outcome.finding, ctx, groupCells));
        return true;
      };
      for (const [language, groupCells] of languages) {
        if (run(language, groupCells)) crossedAny = true;
      }
      if (!crossedAny && languages.size > 1) run(ALL_LANGUAGES, tenantCells);
    }
  }

  if (rulesUnregistered.length > 0) {
    console.warn('[Monitor] skipped rules whose kind has no registry entry', {
      rules_unregistered: rulesUnregistered,
    });
  }
  return { candidates, groupsChecked, groupsInsufficient, rulesUnregistered, contextRules };
}

export interface DriftAlertsInput {
  tenantKey: string;
  report: DriftReport;
  config: MonitorAlertsConfig;
  /** The alert day; defaults to the last day (Sunday) of the report's ISO week. */
  day?: string;
}

/** The Sunday of an ISO week `YYYY-Www`. */
export function isoWeekLastDay(week: string): string {
  const [yearText, weekText] = week.split('-W');
  const year = Number(yearText);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const sunday = new Date(mondayOfWeek1);
  sunday.setUTCDate(mondayOfWeek1.getUTCDate() + (Number(weekText) - 1) * 7 + 6);
  return sunday.toISOString().slice(0, 10);
}

const EPSILON = 1e-9;

/**
 * Turns a weekly DriftReport into test_set_not_representative and offline_online_gap candidates (D-44, D-45).
 * The state is recomputed from the report's numbers; its own `state`, cluster states and gap results are ignored.
 */
export function driftAlerts(input: DriftAlertsInput): AlertCandidate[] {
  const { tenantKey, report, config } = input;
  const day = input.day ?? isoWeekLastDay(report.week);
  const bands = config.drift;
  const out: AlertCandidate[] = [];
  const base = (rule: MonitorRule) => ({
    tenant_key: tenantKey,
    rule: rule.id,
    kind: rule.kind,
    language: ALL_LANGUAGES,
    day,
    window_days: 7,
    breakdown: {},
    companions: [],
    dedup_key: dedupKey(tenantKey, ALL_LANGUAGES, rule.id),
  });

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (rule.kind === 'drift' && rule.warn != null && rule.alert != null) {
      const divergence = report.divergence;
      const nullLevel = report.null_p95;
      const testItems = (report.clusters ?? []).reduce((sum, cluster) => sum + cluster.test_items, 0);
      if (divergence == null || nullLevel == null) continue;
      if (testItems < Math.max(rule.min_sample, bands.min_test_items)) continue;
      if (divergence < rule.warn - EPSILON || divergence <= nullLevel) continue;
      const severity = divergence >= rule.alert - EPSILON ? 'alert' : 'warning';
      const underCovered = (report.clusters ?? [])
        .filter(
          (cluster) =>
            cluster.production_share >= bands.under_covered_min_share - EPSILON &&
            cluster.test_share < bands.under_covered_ratio * cluster.production_share,
        )
        .map((cluster) => cluster.id)
        .sort();
      out.push({
        ...base(rule),
        severity,
        observed: { n: testItems, value: divergence },
        baseline: { n: testItems, value: nullLevel },
        band: { warn: rule.warn, alert: rule.alert, measured_value: divergence },
        cluster_ids: underCovered,
        suggestion: 'review_test_set',
      });
    }
    if (rule.kind === 'offline_online_gap' && rule.alert != null) {
      let worst: { gap: number; online_n: number; offline: number; online: number } | null = null;
      for (const slice of report.gaps ?? []) {
        if (slice.offline == null || slice.online == null || slice.online_n < rule.min_sample) continue;
        const gap = slice.offline - slice.online;
        if (gap < rule.alert - EPSILON) continue;
        if (worst && worst.gap >= gap) continue;
        worst = { gap, online_n: slice.online_n, offline: slice.offline, online: slice.online };
      }
      if (!worst) continue;
      out.push({
        ...base(rule),
        severity: 'alert',
        observed: { n: worst.online_n, value: worst.online },
        baseline: { n: 0, value: worst.offline },
        band: { alert: rule.alert, measured_delta: worst.gap, measured_value: worst.gap },
        cluster_ids: [],
        suggestion: null,
      });
    }
  }
  return out;
}
