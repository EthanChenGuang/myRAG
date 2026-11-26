import rawConfig from '../../../../eval/config/monitor-alerts.json';
import { MonitorAlertsConfigSchema, type MonitorAlertsConfig } from '@/lib/rag-eval/contracts.generated';

type MonitorRule = MonitorAlertsConfig['rules'][number];

/** The model validators of the Pydantic MonitorAlertsConfig that its JSON Schema cannot express. */
function crossFieldProblems(config: MonitorAlertsConfig): string[] {
  const problems: string[] = [];
  const days = config.window_days;
  if (days.some((day) => day < 1) || days.some((day, i) => i > 0 && day <= days[i - 1])) {
    problems.push('window_days');
  }
  const ids = config.rules.map((rule) => rule.id);
  if (new Set(ids).size !== ids.length) problems.push('rule_ids');
  if (config.drift.jsd_alert <= config.drift.jsd_warn) problems.push('drift');
  if (config.sampling.min_queries > config.sampling.max_queries) problems.push('sampling');
  for (const rule of config.rules) {
    if (!ruleFieldsValid(rule)) problems.push(`rule:${rule.id}`);
    if (rule.kind === 'drift' && (rule.warn !== config.drift.jsd_warn || rule.alert !== config.drift.jsd_alert)) {
      problems.push(`rule:${rule.id}:drift_bands`);
    }
    if (rule.kind === 'offline_online_gap' && rule.alert !== config.drift.gap_alert) {
      problems.push(`rule:${rule.id}:gap_alert`);
    }
  }
  return problems;
}

function ruleFieldsValid(rule: MonitorRule): boolean {
  const has = (...names: (keyof MonitorRule)[]) => names.every((name) => rule[name] !== undefined && rule[name] !== null);
  if (rule.kind !== 'language_drop' && !has('metric')) return false;
  switch (rule.kind) {
    case 'rate':
      return has('baseline_min_sample', 'ratio', 'min_abs_delta', 'min_z');
    case 'distribution':
    case 'drift':
      return has('warn', 'alert') && (rule.alert as number) > (rule.warn as number);
    case 'latency':
      return has('baseline_min_sample', 'ratio');
    case 'judge_mean':
      return has('drop');
    case 'offline_online_gap':
      return has('alert');
    default:
      return true;
  }
}

let cached: MonitorAlertsConfig | null | undefined;

export function parseMonitorAlertsConfig(raw: unknown): MonitorAlertsConfig | null {
  const parsed = MonitorAlertsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[Monitor] eval/config/monitor-alerts.json failed the schema; the monitor raises nothing', {
      issues: parsed.error.issues.length,
    });
    return null;
  }
  const problems = crossFieldProblems(parsed.data);
  if (problems.length > 0) {
    console.warn('[Monitor] eval/config/monitor-alerts.json is inconsistent; the monitor raises nothing', { problems });
    return null;
  }
  return parsed.data;
}

/** The committed alert rules (cached per process); a payload passed in is validated without touching the cache. */
export function loadMonitorAlertsConfig(raw?: unknown): MonitorAlertsConfig | null {
  if (raw !== undefined) return parseMonitorAlertsConfig(raw);
  if (cached === undefined) cached = parseMonitorAlertsConfig(rawConfig);
  return cached;
}

export function resetMonitorAlertsConfigCache(): void {
  cached = undefined;
}
