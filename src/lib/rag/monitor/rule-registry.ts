import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod/v3';
import type {
  LatencyBudgets,
  MonitorAlertSchema,
  MonitorAlertsConfig,
  MonitorDailyCell,
} from '@/lib/rag-eval/contracts.generated';
import { evaluateDistribution, evaluateJudgeMean, evaluateLatency, evaluateRate } from './rule-kinds';

export type MonitorRule = MonitorAlertsConfig['rules'][number];
export type MonitorRuleKind = MonitorRule['kind'];
/** Input shape of the alert contract: fields with a schema default may be left out. */
export type MonitorAlertInput = z.input<typeof MonitorAlertSchema>;
type MonitorAlert = MonitorAlertInput;

/** The MonitorAlert fields a rule decides; the store adds id, status, evidence, delivery and timestamps. */
export type AlertCandidate = Pick<
  MonitorAlert,
  | 'tenant_key'
  | 'rule'
  | 'kind'
  | 'language'
  | 'day'
  | 'window_days'
  | 'severity'
  | 'observed'
  | 'band'
  | 'breakdown'
  | 'companions'
  | 'cluster_ids'
  | 'dedup_key'
> & {
  baseline: NonNullable<MonitorAlert['baseline']> | null;
  suggestion: NonNullable<MonitorAlert['suggestion']> | null;
  breakdown: NonNullable<MonitorAlert['breakdown']>;
  companions: NonNullable<MonitorAlert['companions']>;
  cluster_ids: NonNullable<MonitorAlert['cluster_ids']>;
};

/** A candidate before the engine adds the grain, dedup key and companions. */
export type RuleFinding = Pick<AlertCandidate, 'severity' | 'observed' | 'baseline' | 'band' | 'breakdown'> & {
  window_days: number;
  suggestion?: AlertCandidate['suggestion'];
  /** The days whose cells the finding measured, so companions are computed on the same rows. */
  windowRange: DayRange;
  baselineRange: DayRange | null;
};

export interface DayRange {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
}

/** What a daily-cells rule sees for one (tenant, language) group, language `all` for the tenant roll-up. */
export interface DailyCellsContext {
  tenantKey: string;
  language: string;
  day: string;
  config: MonitorAlertsConfig;
  budgets: LatencyBudgets | null;
}

export type GroupOutcome =
  | { status: 'insufficient_sample' }
  | { status: 'within_band' }
  | { status: 'crossed'; finding: RuleFinding };

/** What a context rule is given by runDaily (plan 05.3-27). */
export interface RuleContext {
  admin: SupabaseClient;
  rule: MonitorRule;
  day: string;
  windowDays: readonly number[];
  baselineDays: number;
  tenantKeys: readonly string[];
}

export type RuleKindEntry =
  | {
      input: 'daily_cells';
      /** Pure: `cells` are the rows of one group over the window and baseline days. */
      evaluate(rule: MonitorRule, cells: readonly MonitorDailyCell[], ctx: DailyCellsContext): GroupOutcome;
    }
  | { input: 'context'; evaluate(rule: MonitorRule, ctx: RuleContext): Promise<AlertCandidate[]> }
  | { input: 'report' };

export type RuleKindRegistry = Partial<Record<MonitorRuleKind, RuleKindEntry>>;

/**
 * One entry per rule kind. Phase 7 plan 07-46 adds `language_drop` (a context entry, evaluateLanguageDrop);
 * a configured kind without an entry is skipped and counted as rules_unregistered.
 */
export const RULE_KIND_REGISTRY: RuleKindRegistry = {
  rate: { input: 'daily_cells', evaluate: evaluateRate },
  distribution: { input: 'daily_cells', evaluate: evaluateDistribution },
  latency: { input: 'daily_cells', evaluate: evaluateLatency },
  judge_mean: { input: 'daily_cells', evaluate: evaluateJudgeMean },
  drift: { input: 'report' },
  offline_online_gap: { input: 'report' },
};

export function registryEntryFor(
  kind: string,
  registry: RuleKindRegistry = RULE_KIND_REGISTRY,
): RuleKindEntry | undefined {
  return Object.prototype.hasOwnProperty.call(registry, kind) ? registry[kind as MonitorRuleKind] : undefined;
}
