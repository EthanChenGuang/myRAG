import { describe, expect, it } from 'vitest';
import { RULE_KIND_REGISTRY, type MonitorRule, type RuleContext } from '@/lib/rag/monitor/rule-registry';
import { dedupKey } from '@/lib/rag/monitor/rules';
import { loadMonitorAlertsConfig } from '@/lib/rag/monitor/alerts-config';

// G2 / RET-14 of the 6.3 verification: the daily stale_index_drop rule reads the source recheck counts of the retrieval log
// (rag_monitor_stale_index_drop, 1013) and raises a warning for any drop, an alert from the configured rate up.

const TENANT_A = 's:default';
const TENANT_B = 'u:00000000-0000-4000-8000-0000000000b2';

function ctxWith(rows: Array<{ tenant_key: string; retrievals: number; checked: number; dropped: number }>, calls: unknown[] = []): RuleContext {
  const admin = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { data: rows, error: null };
    },
  };
  return { admin: admin as never, rule: undefined as never, day: '2026-11-27', windowDays: [1, 3, 7], baselineDays: 28, tenantKeys: [TENANT_A] };
}

function staleRule(): MonitorRule {
  const config = loadMonitorAlertsConfig();
  const rule = config?.rules.find((entry) => entry.id === 'stale_index_drop_rate');
  if (!rule) throw new Error('stale_index_drop_rate is not configured');
  return rule;
}

describe('stale_index_drop daily rule', () => {
  it('is configured in eval/config/monitor-alerts.json and registered as a context rule', () => {
    const rule = staleRule();
    expect(rule).toMatchObject({ kind: 'stale_index_drop', metric: 'stale_index_drop', warn: 0, alert: 0.05 });
    expect(RULE_KIND_REGISTRY.stale_index_drop?.input).toBe('context');
  });

  it('one candidate per tenant with a drop: warning below the alert rate, alert from it up; nothing for a tenant without drops', async () => {
    const entry = RULE_KIND_REGISTRY.stale_index_drop;
    if (!entry || entry.input !== 'context') throw new Error('not a context rule');
    const calls: unknown[] = [];
    const rule = staleRule();
    const candidates = await entry.evaluate(
      rule,
      ctxWith(
        [
          { tenant_key: TENANT_A, retrievals: 40, checked: 400, dropped: 2 },
          { tenant_key: TENANT_B, retrievals: 10, checked: 100, dropped: 9 },
          { tenant_key: 'u:00000000-0000-4000-8000-0000000000c3', retrievals: 5, checked: 50, dropped: 0 },
        ],
        calls,
      ),
    );
    expect(calls).toEqual([{ name: 'rag_monitor_stale_index_drop', args: { p_day: '2026-11-27' } }]);
    expect(candidates.map((c) => [c.tenant_key, c.severity, c.observed.count, c.observed.n])).toEqual([
      [TENANT_A, 'warning', 2, 400],
      [TENANT_B, 'alert', 9, 100],
    ]);
    expect(candidates[0]).toMatchObject({
      rule: 'stale_index_drop_rate',
      kind: 'stale_index_drop',
      language: 'all',
      day: '2026-11-27',
      window_days: 1,
      baseline: null,
      suggestion: null,
      dedup_key: dedupKey(TENANT_A, 'all', 'stale_index_drop_rate'),
    });
    expect(candidates[0]?.observed.value).toBeCloseTo(0.005);
  });

  it('raises nothing below min_sample checked candidates or with no logged recheck', async () => {
    const entry = RULE_KIND_REGISTRY.stale_index_drop;
    if (!entry || entry.input !== 'context') throw new Error('not a context rule');
    const rule = { ...staleRule(), min_sample: 500 };
    expect(await entry.evaluate(rule, ctxWith([{ tenant_key: TENANT_A, retrievals: 40, checked: 400, dropped: 2 }]))).toEqual([]);
    expect(await entry.evaluate(staleRule(), ctxWith([]))).toEqual([]);
  });
});
