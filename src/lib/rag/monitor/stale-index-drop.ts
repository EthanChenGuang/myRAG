import { createHash } from 'node:crypto';
import type { AlertCandidate, MonitorRule, RuleContext } from './rule-registry';

/** A row of rag_monitor_stale_index_drop (1013): one tenant's logged retrievals of the day with a completed source recheck. */
interface StaleDropRow {
  tenant_key: string;
  retrievals: number | string;
  checked: number | string;
  dropped: number | string;
}

const ALL = 'all';

function count(value: number | string): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/** The same key as rules.ts dedupKey (tenant | language | rule), kept local so the registry does not import the engine. */
function dedupKey(tenantKey: string, language: string, rule: string): string {
  return createHash('sha256').update(`${tenantKey}|${language}|${rule}`, 'utf8').digest('hex');
}

/**
 * RET-14 on OBS-03 (Phase 6.3 G2): the day's dropped share of source-rechecked candidates per tenant. A rate above `warn`
 * (0 in the committed config: any drop) is a warning, from `alert` up an alert; a tenant with fewer than `min_sample` checked
 * candidates, or with no logged recheck, raises nothing. Reads counts only (the retrieval log holds no text for this).
 */
export async function evaluateStaleIndexDrop(rule: MonitorRule, ctx: RuleContext): Promise<AlertCandidate[]> {
  const { data, error } = await ctx.admin.rpc('rag_monitor_stale_index_drop', { p_day: ctx.day });
  if (error) throw new Error(`[Monitor] rag_monitor_stale_index_drop failed (${(error as { code?: string }).code ?? 'unknown'})`);
  const warn = rule.warn ?? 0;
  const alert = rule.alert ?? 1;
  const out: AlertCandidate[] = [];
  for (const row of (data ?? []) as StaleDropRow[]) {
    if (typeof row.tenant_key !== 'string') continue;
    const checked = count(row.checked);
    const dropped = Math.min(count(row.dropped), checked);
    if (checked < rule.min_sample || checked === 0) continue;
    const rate = dropped / checked;
    if (!(rate > warn)) continue;
    out.push({
      tenant_key: row.tenant_key,
      rule: rule.id,
      kind: rule.kind,
      language: ALL,
      day: ctx.day,
      window_days: 1,
      severity: rate >= alert ? 'alert' : 'warning',
      observed: { count: dropped, n: checked, value: rate },
      baseline: null,
      band: { warn, alert, measured_value: rate },
      breakdown: {},
      companions: [],
      cluster_ids: [],
      suggestion: null,
      dedup_key: dedupKey(row.tenant_key, ALL, rule.id),
    });
  }
  return out;
}
