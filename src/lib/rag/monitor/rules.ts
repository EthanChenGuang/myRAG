import type { DriftReport, LatencyBudgets, MonitorAlertsConfig, MonitorDailyCell } from '@/lib/rag-eval/contracts.generated';
import type { AlertCandidate, MonitorRule, RuleKindEntry, RuleKindRegistry } from './rule-registry';

export type { AlertCandidate } from './rule-registry';

export interface EvaluateRulesInput {
  cells: readonly MonitorDailyCell[];
  day: string;
  config: MonitorAlertsConfig;
  budgets?: LatencyBudgets | null;
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
  contextRules: ContextRule[];
}
export function dedupKey(_tenantKey: string, _language: string, _rule: string): string {
  return '';
}
export function evaluateRules(_input: EvaluateRulesInput): EvaluateRulesResult {
  return { candidates: [], groupsChecked: 0, groupsInsufficient: 0, rulesUnregistered: [], contextRules: [] };
}
export function isoWeekLastDay(_week: string): string {
  return '';
}
export function driftAlerts(_input: { tenantKey: string; report: DriftReport; config: MonitorAlertsConfig; day?: string }): AlertCandidate[] {
  return [];
}
