import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMonitorAlertsConfig } from '@/lib/rag/monitor/alerts-config';
import { toUpsertPayload, toMonitorAlert } from '@/lib/rag/monitor/alerts-store';
import { driftAlerts } from '@/lib/rag/monitor/rules';
import { latestDrift, storeDriftReport } from '@/lib/rag/monitor/drift-store';
import type { MonitorAlertsConfig } from '@/lib/rag-eval/contracts.generated';
import { fakeAdmin, type FakeAdmin } from '../helpers/monitor-drift-fake';

const TENANT = 'o:00000000-0000-4000-8000-0000000033c0';
const OTHER_TENANT = 'o:00000000-0000-4000-8000-0000000033c1';
const NOW = new Date('2026-11-26T12:00:00.000Z');
const CONFIG = loadMonitorAlertsConfig() as MonitorAlertsConfig;

/** A shift of production traffic towards c-07, which the test set barely covers. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    week: '2026-W47',
    state: 'ok',
    divergence: 0.24,
    null_p95: 0.07,
    limits: { warn: 0.5, alert: 0.9, gap: 0.9 },
    trend: [{ week: '2026-W46', divergence: 0.01, state: 'ok' }],
    clusters: [
      { id: 'c-07', production_share: 0.22, test_share: 0.04, test_items: 3, state: 'ok' },
      { id: 'c-02', production_share: 0.18, test_share: 0.2, test_items: 14, state: 'ok' },
      { id: 'c-03', production_share: 0.54, test_share: 0.72, test_items: 50, state: 'ok' },
      { id: 'novel', production_share: 0.06, test_share: 0.04, test_items: 3, state: 'under' },
    ],
    ...overrides,
  };
}

function store(): FakeAdmin {
  const admin = fakeAdmin({ rag_drift_weekly: [], rag_monitor_alerts: [] });
  admin.rpcs.rag_drift_weekly_upsert = (args) => {
    const rows = admin.tables.rag_drift_weekly as Array<Record<string, unknown>>;
    const report = args.p_report as Record<string, unknown>;
    const existing = rows.find((row) => row.tenant_key === args.p_tenant_key && row.week === args.p_week);
    const values = { divergence: report.divergence, null_p95: report.null_p95 ?? null, state: report.state, report };
    if (existing) Object.assign(existing, values);
    else rows.push({ tenant_key: args.p_tenant_key, week: args.p_week, ...values });
    return { data: !existing, error: null };
  };
  admin.rpcs.rag_monitor_alert_upsert = (args) => {
    const alert = args.p_alert as Record<string, unknown>;
    const rows = admin.tables.rag_monitor_alerts as Array<Record<string, unknown>>;
    const existing = rows.find((row) => row.tenant_key === alert.tenant_key && row.dedup_key === alert.dedup_key && row.status !== 'resolved');
    if (existing) {
      Object.assign(existing, alert, { id: existing.id, status: existing.status });
      return { data: existing.id, error: null };
    }
    const id = `alert-${rows.length + 1}`;
    rows.push({ ...alert, id, status: 'open' });
    return { data: id, error: null };
  };
  return admin;
}

let admin: FakeAdmin;

beforeEach(() => {
  admin = store();
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

describe('storeDriftReport (D-44, D-45)', () => {
  it('stores the report with its state recomputed and raises one test_set_not_representative alert naming c-07', async () => {
    const result = await storeDriftReport(admin.client as never, { tenantKey: TENANT, report: report(), config: CONFIG, monitorOn: true, channels: [], now: NOW });
    expect(result).toMatchObject({ ok: true, week: '2026-W47', state: 'alert', inserted: true });
    const rows = admin.tables.rag_drift_weekly as Array<Record<string, any>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_key: TENANT, week: '2026-11-16', state: 'alert', divergence: 0.24, null_p95: 0.07 });
    const states = Object.fromEntries((rows[0]?.report.clusters as Array<{ id: string; state: string }>).map((c) => [c.id, c.state]));
    expect(states).toEqual({ 'c-07': 'under', 'c-02': 'ok', 'c-03': 'off', novel: 'ok' });
    expect(rows[0]?.report.limits).toEqual({ warn: 0.1, alert: 0.2, gap: 0.15 });
    expect(rows[0]?.report).not.toHaveProperty('trend');
    const alerts = (admin.tables.rag_monitor_alerts as Array<Record<string, any>>).filter((a) => a.rule === 'test_set_not_representative');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ tenant_key: TENANT, severity: 'alert', cluster_ids: ['c-07'], day: '2026-11-22' });
  });

  it('a second post for the same week updates the row and the alert, one of each', async () => {
    await storeDriftReport(admin.client as never, { tenantKey: TENANT, report: report(), config: CONFIG, monitorOn: true, channels: [], now: NOW });
    const again = await storeDriftReport(admin.client as never, {
      tenantKey: TENANT,
      report: report({ divergence: 0.26 }),
      config: CONFIG,
      monitorOn: true,
      channels: [],
      now: NOW,
    });
    expect(again).toMatchObject({ ok: true, inserted: false, alerts: { opened: 0, updated: 1 } });
    expect(admin.tables.rag_drift_weekly).toHaveLength(1);
    expect((admin.tables.rag_drift_weekly as Array<Record<string, unknown>>)[0]?.divergence).toBe(0.26);
    expect((admin.tables.rag_monitor_alerts as Array<Record<string, unknown>>).filter((a) => a.rule === 'test_set_not_representative')).toHaveLength(1);
  });

  it('ignores the state the client claims', async () => {
    const claimedOk = await storeDriftReport(admin.client as never, { tenantKey: TENANT, report: report({ state: 'ok' }), config: CONFIG, monitorOn: false, now: NOW });
    expect(claimedOk).toMatchObject({ ok: true, state: 'alert' });
    const claimedAlert = await storeDriftReport(admin.client as never, {
      tenantKey: TENANT,
      report: report({ week: '2026-W46', state: 'alert', divergence: 0.02 }),
      config: CONFIG,
      monitorOn: false,
      now: NOW,
    });
    expect(claimedAlert).toMatchObject({ ok: true, state: 'ok' });
  });

  it('recomputes the offline-online gap verdicts and raises offline_online_gap from them', async () => {
    const gaps = [
      { slice: 'all', offline: 0.85, online: 0.65, online_n: 80, gap: 0, result: 'passed' },
      { slice: 'language:xx', offline: 0.9, online: 0.5, online_n: 10, gap: null, result: 'failed' },
      { slice: 'channel:chat', offline: 0.8, online: 0.75, online_n: 90, gap: 0.5, result: 'failed' },
    ];
    await storeDriftReport(admin.client as never, { tenantKey: TENANT, report: report({ gaps }), config: CONFIG, monitorOn: true, channels: [], now: NOW });
    const stored = (admin.tables.rag_drift_weekly as Array<Record<string, any>>)[0]?.report.gaps as Array<Record<string, unknown>>;
    expect(stored.map((g) => [g.slice, g.result])).toEqual([
      ['all', 'failed'],
      ['language:xx', 'insufficient_n'],
      ['channel:chat', 'passed'],
    ]);
    expect(stored[0]?.gap).toBeCloseTo(0.2, 9);
    const rules = (admin.tables.rag_monitor_alerts as Array<Record<string, unknown>>).map((a) => a.rule).sort();
    expect(rules).toEqual(['offline_online_gap', 'test_set_not_representative']);
  });

  it('with RAG_MONITOR off stores the report and raises nothing', async () => {
    const result = await storeDriftReport(admin.client as never, { tenantKey: TENANT, report: report(), config: CONFIG, monitorOn: false, now: NOW });
    expect(result).toMatchObject({ ok: true, state: 'alert', alerts: { opened: 0, updated: 0 } });
    expect(admin.tables.rag_drift_weekly).toHaveLength(1);
    expect(admin.tables.rag_monitor_alerts).toEqual([]);
    expect(admin.rpcCalls.map((call) => call.name)).toEqual(['rag_drift_weekly_upsert']);
  });

  it('refuses an invalid report, a missing divergence or an impossible week without writing', async () => {
    for (const bad of [
      { ...report(), clusters: [{ id: 'A sentence', production_share: 0.5, test_share: 0.5, test_items: 1, state: 'ok' }] },
      { ...report(), extra: 'x' },
      report({ divergence: null }),
      report({ week: '2026-W60' }),
      'not an object',
    ]) {
      const result = await storeDriftReport(admin.client as never, { tenantKey: TENANT, report: bad, config: CONFIG, monitorOn: true, now: NOW });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid_report');
        expect(result.details.length).toBeGreaterThan(0);
      }
    }
    expect(admin.rpcCalls).toEqual([]);
  });

  it('sends the cluster ids of the alert to the store (0978)', () => {
    const [candidate] = driftAlerts({ tenantKey: TENANT, report: report() as never, config: CONFIG });
    const alert = toMonitorAlert(candidate!, { sampleTraceIds: [], configChanges: [] }, {}, NOW);
    expect(toUpsertPayload(alert!).cluster_ids).toEqual(['c-07']);
  });
});

describe('latestDrift (UI-SPEC 6.8, 8.1)', () => {
  function seedWeeks(weeks: Array<[string, number, string]>, tenant = TENANT) {
    for (const [week, divergence, state] of weeks) {
      (admin.tables.rag_drift_weekly as Array<Record<string, unknown>>).push({
        tenant_key: tenant,
        week,
        divergence,
        null_p95: 0.07,
        state,
        report: {
          week: 'ignored',
          divergence,
          state,
          null_p95: 0.07,
          limits: { warn: 0.1, alert: 0.2, gap: 0.15 },
          clusters: [
            { id: 'c-02', production_share: 0.18, test_share: 0.2, test_items: 14, state: 'ok' },
            { id: 'novel', production_share: 0.3, test_share: 0.04, test_items: 3, state: 'under' },
            { id: 'c-07', production_share: 0.22, test_share: 0.04, test_items: 3, state: 'under' },
          ],
          ...(week === '2026-11-16' ? { scores: { unweighted: 0.82, weighted: 0.77, uncovered_share: 0.12 } } : {}),
        },
      });
    }
  }

  it('returns the latest week, the trend of the 8 weeks up to it with missing weeks absent, and clusters by production share', async () => {
    seedWeeks([
      ['2026-11-16', 0.24, 'alert'],
      ['2026-11-09', 0.12, 'warn'],
      ['2026-10-26', 0.05, 'ok'],
      ['2026-09-28', 0.03, 'ok'],
      ['2026-09-21', 0.9, 'alert'],
    ]);
    seedWeeks([['2026-11-23', 0.99, 'alert']], OTHER_TENANT);
    const drift = await latestDrift(admin.client as never, TENANT, CONFIG);
    expect(drift.week).toBe('2026-W47');
    expect(drift.divergence).toBe(0.24);
    expect(drift.state).toBe('alert');
    expect(drift.limits).toEqual({ warn: 0.1, alert: 0.2, gap: 0.15 });
    expect(drift.trend).toEqual([
      { week: '2026-W47', divergence: 0.24, state: 'alert' },
      { week: '2026-W46', divergence: 0.12, state: 'warn' },
      { week: '2026-W44', divergence: 0.05, state: 'ok' },
      { week: '2026-W40', divergence: 0.03, state: 'ok' },
    ]);
    expect(drift.clusters.map((c) => c.id)).toEqual(['novel', 'c-07', 'c-02']);
    expect(drift.scores).toEqual({ unweighted: 0.82, weighted: 0.77, uncovered_share: 0.12 });
    expect(drift).not.toHaveProperty('gaps');
    expect(drift).not.toHaveProperty('rates');
    for (const call of admin.calls) expect(call.filters).toContainEqual({ op: 'eq', column: 'tenant_key', value: TENANT });
  });

  it('returns an empty view with the limits when the tenant has no report', async () => {
    seedWeeks([['2026-11-16', 0.24, 'alert']], OTHER_TENANT);
    expect(await latestDrift(admin.client as never, TENANT, CONFIG)).toEqual({
      week: null,
      divergence: null,
      null_p95: null,
      state: null,
      limits: { warn: 0.1, alert: 0.2, gap: 0.15 },
      trend: [],
      clusters: [],
    });
  });
});
