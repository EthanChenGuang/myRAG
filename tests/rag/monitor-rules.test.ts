import { afterEach, describe, expect, it, vi } from 'vitest';
import budgetsJson from '../../eval/config/latency-budgets.json';
import {
  DriftReportSchema,
  LatencyBudgetsSchema,
  MonitorAlertSchema,
  type DriftReport,
  type MonitorAlertsConfig,
  type MonitorDailyCell,
} from '@/lib/rag-eval/contracts.generated';
import { loadMonitorAlertsConfig } from '@/lib/rag/monitor/alerts-config';
import { RULE_KIND_REGISTRY, registryEntryFor, type RuleKindRegistry } from '@/lib/rag/monitor/rule-registry';
import { dedupKey, driftAlerts, evaluateRules, isoWeekLastDay, type AlertCandidate } from '@/lib/rag/monitor/rules';
import { buildDailyCells, dayOf, TENANT_A, TENANT_B, type CellSeed } from '../helpers/monitor-cells';

const config = loadMonitorAlertsConfig() as MonitorAlertsConfig;
const budgets = LatencyBudgetsSchema.parse(budgetsJson);
const FIRST = '2026-03-01';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Flat background: only the fields a test sets move. */
function seed(overrides: Partial<CellSeed> & Pick<CellSeed, 'days'>): MonitorDailyCell[] {
  return buildDailyCells({
    firstDay: FIRST,
    rows: 50,
    ...overrides,
    rates: { refused: 0.12, zero_result: 0.04, below_threshold: 0.06, ...overrides.rates },
    counts: { helpful: 10, not_helpful: 2, ...overrides.counts },
  });
}

function run(cells: MonitorDailyCell[], dayIndex: number, cfg: MonitorAlertsConfig = config) {
  return evaluateRules({ cells, day: dayOf(FIRST, dayIndex), config: cfg, budgets });
}

function asStoredAlert(candidate: AlertCandidate) {
  return {
    ...candidate,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'open',
    created_at: '2026-03-05T00:00:00Z',
    updated_at: '2026-03-05T00:00:00Z',
    baseline: candidate.baseline ?? undefined,
    suggestion: candidate.suggestion ?? undefined,
  };
}

describe('refusal rate (success criterion 3, research Pitfall 16)', () => {
  const rising = (i: number) => (i >= 5 ? 0.38 : 0.12);

  it('12% to 38% on day 5 with votes flat raises exactly one alert, refusal_rate, for the tenant and language', () => {
    const cells = seed({ days: 5, rates: { refused: rising } });
    const result = run(cells, 5);
    expect(result.candidates).toHaveLength(1);
    const [alert] = result.candidates;
    expect(alert).toMatchObject({ tenant_key: TENANT_A, language: 'it', rule: 'refusal_rate', kind: 'rate', window_days: 1 });
    expect(alert.observed).toMatchObject({ count: 19, n: 50 });
    expect(alert.baseline).toMatchObject({ count: 24, n: 200 });
    expect(alert.band.measured_z).toBeCloseTo(4.36, 2);
    expect(alert.band.measured_ratio).toBeCloseTo(0.38 / 0.12, 6);
    expect(alert.band).toMatchObject({ ratio: 2, min_abs_delta: 0.05, min_z: 3 });
    const ids = result.candidates.map((c) => c.rule);
    for (const quiet of ['not_helpful_rate', 'below_threshold_rate', 'top_score_psi']) expect(ids).not.toContain(quiet);
    expect(alert.companions.map((c) => c.rule)).toContain('not_helpful_rate');
    expect(alert.companions.find((c) => c.rule === 'not_helpful_rate')).toMatchObject({ n: 12 });
    expect(MonitorAlertSchema.safeParse(asStoredAlert(alert)).success).toBe(true);
  });

  it('day 6 yields the same dedup key, so the stored alert is updated instead of added', () => {
    const cells = seed({ days: 6, rates: { refused: rising } });
    const day5 = run(cells, 5).candidates;
    const day6 = run(cells, 6).candidates;
    expect(day5).toHaveLength(1);
    expect(day6).toHaveLength(1);
    expect(day6[0].day).not.toBe(day5[0].day);
    expect(day6[0].dedup_key).toBe(day5[0].dedup_key);
    expect(day6[0].dedup_key).toBe(dedupKey(TENANT_A, 'it', 'refusal_rate'));
  });

  it('35 days at 12% then 38% on the last day still raise exactly one alert', () => {
    const cells = seed({ days: 35, rates: { refused: (i) => (i === 35 ? 0.38 : 0.12) } });
    const result = run(cells, 35);
    expect(result.candidates.map((c) => [c.rule, c.language])).toEqual([['refusal_rate', 'it']]);
    expect(result.candidates[0].baseline?.n).toBe(1500);
  });

  it('two languages rising together give one alert per language and no tenant-wide alert', () => {
    const cells = [
      ...seed({ days: 5, language: 'it', rates: { refused: rising } }),
      ...seed({ days: 5, language: 'zh', rates: { refused: rising } }),
    ];
    const result = run(cells, 5);
    expect(result.candidates.map((c) => [c.rule, c.language]).sort()).toEqual([
      ['refusal_rate', 'it'],
      ['refusal_rate', 'zh'],
    ]);
  });

  it('a rise no single language explains but the tenant total does gives one alert with language all', () => {
    const thin = (i: number) => (i >= 5 ? 0.26 : 0.12);
    const cells = ['de', 'en', 'fr', 'it', 'zh'].flatMap((language) => seed({ days: 5, language, rates: { refused: thin } }));
    const result = run(cells, 5);
    expect(result.candidates.map((c) => [c.rule, c.language])).toEqual([['refusal_rate', 'all']]);
    expect(result.candidates[0].observed).toMatchObject({ count: 65, n: 250 });
    expect(result.candidates[0].dedup_key).toBe(dedupKey(TENANT_A, 'all', 'refusal_rate'));
  });

  it('keeps tenants apart', () => {
    const cells = [
      ...seed({ days: 5, rates: { refused: rising } }),
      ...seed({ days: 5, tenantKey: TENANT_B }),
    ];
    const result = run(cells, 5);
    expect(result.candidates.map((c) => c.tenant_key)).toEqual([TENANT_A]);
  });
});

describe('window widening and minimum samples (D-24)', () => {
  it('30 rows: widened to 3 then 7 days, still below 50 rows, raises nothing and counts the cells as insufficient', () => {
    const cells = seed({ days: 3, rows: 10, rates: { refused: 0.9 } });
    const result = run(cells, 3);
    expect(result.candidates).toEqual([]);
    expect(result.groupsChecked).toBe(11);
    expect(result.groupsInsufficient).toBe(result.groupsChecked);
  });

  it('widens to the 7-day window when the shorter windows hold too few rows', () => {
    const cells = seed({ days: 40, rows: 10, rates: { refused: (i) => (i > 33 ? 0.4 : 0.1) } });
    const result = run(cells, 40);
    const refusal = result.candidates.find((c) => c.rule === 'refusal_rate');
    expect(refusal?.window_days).toBe(7);
    expect(refusal?.observed).toMatchObject({ count: 28, n: 70 });
    expect(refusal?.baseline).toMatchObject({ n: 300 });
  });

  it('raises nothing while the baseline is below its own minimum', () => {
    const cells = seed({ days: 3, rates: { refused: (i) => (i === 3 ? 0.5 : 0.1) } });
    expect(run(cells, 3).candidates).toEqual([]);
  });
});

describe('top-score distribution (research Pitfall 15)', () => {
  it('a shift of about 0.10 with 300 window rows and 3000 baseline rows suggests recalibration', () => {
    const cells = seed({
      days: 33,
      rows: 100,
      topScore: { similarity: (i) => ({ center: i > 30 ? 0.7 : 0.6, rows: 100 }) },
    });
    const result = run(cells, 33);
    expect(result.candidates.map((c) => c.rule)).toEqual(['top_score_psi']);
    const [alert] = result.candidates;
    expect(alert).toMatchObject({ severity: 'alert', suggestion: 'recalibrate_refusal', window_days: 3 });
    expect(alert.observed.n).toBe(300);
    expect(alert.baseline?.n).toBe(3000);
    expect(alert.band.measured_value).toBeGreaterThanOrEqual(0.25);
    expect(MonitorAlertSchema.safeParse(asStoredAlert(alert)).success).toBe(true);
  });

  it('the same shift with 50 window rows raises nothing', () => {
    const baseline = seed({ days: 30, rows: 100, topScore: { similarity: { center: 0.6, rows: 100 } } });
    const late = seed({ days: 37, rows: 50, topScore: { similarity: { center: 0.7, rows: 50 } } }).slice(36);
    const result = run([...baseline, ...late], 37);
    expect(result.candidates.map((c) => c.rule)).not.toContain('top_score_psi');
  });

  it('a stable distribution raises nothing', () => {
    const cells = seed({ days: 33, rows: 100, topScore: { rerank: { center: 0.5, rows: 100 } } });
    expect(run(cells, 33).candidates).toEqual([]);
  });
});

describe('latency p95 (D-24)', () => {
  it('a p95 above 1.5 times the baseline raises latency_p95', () => {
    const cells = seed({ days: 31, rows: 100, latencyBin: (i) => (i === 31 ? 6 : 3) });
    const result = run(cells, 31);
    expect(result.candidates.map((c) => c.rule)).toEqual(['latency_p95']);
    const [alert] = result.candidates;
    expect(alert.observed.value).toBe(500);
    expect(alert.baseline?.value).toBe(200);
    expect(alert.band).toMatchObject({ ratio: 1.5, measured_ratio: 2.5, budget: 2000 });
  });

  it('a p95 above the channel budget with an unchanged baseline is listed with band.budget', () => {
    const cells = seed({ days: 31, rows: 100, channel: 'voice', latencyBin: 8 });
    const result = run(cells, 31);
    expect(result.candidates.map((c) => c.rule)).toEqual(['latency_p95']);
    expect(result.candidates[0].band).toMatchObject({ budget: 800, measured_ratio: 1, measured_value: 1000 });
    expect(result.candidates[0].breakdown.by_channel?.voice).toMatchObject({ n: 100, value: 1000 });
  });
});

describe('online judge mean (D-24)', () => {
  it('a drop of 0.12 with the minimum sample raises online_judge_mean', () => {
    const cells = seed({
      days: 31,
      counts: { judged: 60 },
      judgeMeans: { faithfulness: (i) => (i === 31 ? 0.68 : 0.8) },
    });
    const result = run(cells, 31);
    expect(result.candidates.map((c) => c.rule)).toEqual(['online_judge_mean']);
    expect(result.candidates[0].observed.value).toBeCloseTo(0.68, 6);
    expect(result.candidates[0].band.measured_delta).toBeCloseTo(-0.12, 6);
  });

  it('a drop of 0.05 raises nothing', () => {
    const cells = seed({ days: 31, counts: { judged: 60 }, judgeMeans: { faithfulness: (i) => (i === 31 ? 0.75 : 0.8) } });
    expect(run(cells, 31).candidates).toEqual([]);
  });
});

describe('breakdown and contract (D-25, D-26)', () => {
  it('kb_degraded_rate crossing its band lists mode, channel and document type counts', () => {
    const degraded = { degraded: (i: number) => (i === 31 ? 0.2 : 0.02) };
    const cells = [
      ...seed({ days: 31, ragMode: 'strict', channel: 'chat', docType: 'policy', rates: degraded }),
      ...seed({ days: 31, ragMode: 'balanced', channel: 'embed', docType: 'manual', rates: degraded }),
      ...seed({ days: 31, ragMode: 'strict', channel: 'voice', docType: 'manual', rates: degraded }),
    ];
    const result = run(cells, 31);
    expect(result.candidates.map((c) => c.rule)).toEqual(['kb_degraded_rate']);
    const { breakdown } = result.candidates[0];
    expect(Object.keys(breakdown.by_mode ?? {}).sort()).toEqual(['balanced', 'strict']);
    expect(Object.keys(breakdown.by_channel ?? {}).sort()).toEqual(['chat', 'embed', 'voice']);
    expect(breakdown.by_doc_type?.manual).toMatchObject({ count: 20, n: 100 });
    expect(breakdown.by_doc_type?.policy).toMatchObject({ count: 10, n: 50 });
    expect(MonitorAlertSchema.safeParse(asStoredAlert(result.candidates[0])).success).toBe(true);
  });

  it('every candidate holds numbers and codes only', () => {
    const cells = seed({ days: 5, rates: { refused: (i) => (i >= 5 ? 0.38 : 0.12) } });
    const strings: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(run(cells, 5).candidates);
    for (const value of strings) expect(value).toMatch(/^[A-Za-z0-9:_.|-]+$/);
  });
});

describe('rule-kind registry (LANG-10 hook point)', () => {
  const withLanguageDrop: MonitorAlertsConfig = {
    ...config,
    rules: [...config.rules, { id: 'language_drop', kind: 'language_drop', min_sample: 50, enabled: true }],
  };

  it('has no language_drop entry in this phase', () => {
    expect(registryEntryFor('language_drop')).toBeUndefined();
    expect(registryEntryFor('rate')?.input).toBe('daily_cells');
    expect(registryEntryFor('drift')?.input).toBe('report');
    expect(registryEntryFor('offline_online_gap')?.input).toBe('report');
    expect(registryEntryFor('toString')).toBeUndefined();
  });

  it('skips a configured kind without an entry with one [Monitor] warning and returns the other candidates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cells = seed({ days: 5, rates: { refused: (i) => (i >= 5 ? 0.38 : 0.12) } });
    const result = run(cells, 5, withLanguageDrop);
    expect(result.rulesUnregistered).toEqual(['language_drop']);
    expect(result.candidates.map((c) => c.rule)).toEqual(['refusal_rate']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[Monitor\]/);
  });

  it('dispatches a registered stub daily-cells entry and returns context entries for runDaily', () => {
    const stub: RuleKindRegistry = {
      ...RULE_KIND_REGISTRY,
      language_drop: {
        input: 'daily_cells',
        evaluate: (_rule, _cells, ctx) => ({
          status: 'crossed',
          finding: {
            severity: 'alert',
            window_days: 1,
            windowRange: { from: ctx.day, to: ctx.day },
            baselineRange: null,
            observed: { n: 50, value: 0.4 },
            baseline: null,
            band: { measured_value: 0.4 },
            breakdown: {},
          },
        }),
      },
    };
    const cells = seed({ days: 5 });
    const result = evaluateRules({ cells, day: dayOf(FIRST, 5), config: withLanguageDrop, budgets, registry: stub });
    expect(result.rulesUnregistered).toEqual([]);
    expect(result.candidates.map((c) => [c.rule, c.language])).toEqual([['language_drop', 'it']]);

    const evaluate = vi.fn(async () => []);
    const context: RuleKindRegistry = { ...RULE_KIND_REGISTRY, language_drop: { input: 'context', evaluate } };
    const deferred = evaluateRules({ cells, day: dayOf(FIRST, 5), config: withLanguageDrop, budgets, registry: context });
    expect(deferred.contextRules.map((entry) => entry.rule.id)).toEqual(['language_drop']);
    expect(evaluate).not.toHaveBeenCalled();
  });
});

function driftReport(overrides: Partial<DriftReport>): DriftReport {
  return DriftReportSchema.parse({
    week: '2026-W10',
    divergence: 0.24,
    state: 'ok',
    null_p95: 0.07,
    limits: { warn: 0.1, alert: 0.2, gap: 0.15 },
    clusters: [
      { id: 'c01', production_share: 0.3, test_share: 0.05, test_items: 5, state: 'ok' },
      { id: 'c02', production_share: 0.7, test_share: 0.95, test_items: 95, state: 'ok' },
    ],
    ...overrides,
  });
}

describe('driftAlerts (D-44, D-45, research Pitfall 18)', () => {
  it('a divergence above its band and above the permutation null names the under-covered cluster', () => {
    const candidates = driftAlerts({ tenantKey: TENANT_A, report: driftReport({}), config });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      rule: 'test_set_not_representative',
      severity: 'alert',
      suggestion: 'review_test_set',
      cluster_ids: ['c01'],
      language: 'all',
      day: '2026-03-08',
    });
    expect(MonitorAlertSchema.safeParse(asStoredAlert(candidates[0])).success).toBe(true);
  });

  it('recomputes the state: a report claiming ok whose numbers cross still alerts, one claiming alert below the null does not', () => {
    expect(driftAlerts({ tenantKey: TENANT_A, report: driftReport({ state: 'ok' }), config })).toHaveLength(1);
    const noisy = driftReport({ divergence: 0.12, null_p95: 0.18, state: 'alert' });
    expect(driftAlerts({ tenantKey: TENANT_A, report: noisy, config })).toEqual([]);
  });

  it('raises nothing below the minimum number of test items', () => {
    const few = driftReport({
      clusters: [
        { id: 'c01', production_share: 0.3, test_share: 0.05, test_items: 2, state: 'under' },
        { id: 'c02', production_share: 0.7, test_share: 0.95, test_items: 20, state: 'ok' },
      ],
    });
    expect(driftAlerts({ tenantKey: TENANT_A, report: few, config })).toEqual([]);
  });

  it('an offline-online gap of 0.20 with enough online judgements raises offline_online_gap', () => {
    const report = driftReport({
      divergence: 0.02,
      gaps: [
        { slice: 'language:it', offline: 0.85, online: 0.65, online_n: 80, gap: 0, result: 'passed' },
        { slice: 'language:zh', offline: 0.9, online: 0.5, online_n: 10, result: 'insufficient_n' },
      ],
    });
    const candidates = driftAlerts({ tenantKey: TENANT_A, report, config });
    expect(candidates.map((c) => c.rule)).toEqual(['offline_online_gap']);
    expect(candidates[0].band.measured_delta).toBeCloseTo(0.2, 6);
    expect(candidates[0].observed).toMatchObject({ n: 80 });
  });

  it('isoWeekLastDay returns the Sunday of the ISO week', () => {
    expect(isoWeekLastDay('2026-W10')).toBe('2026-03-08');
    expect(isoWeekLastDay('2026-W01')).toBe('2026-01-04');
  });
});
