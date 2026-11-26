import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allocateStrata,
  isoWeekLabel,
  loadSampleConfig,
  planWeeklySample,
  sampleWindow,
  stratumKey,
  type SampleCandidateRow,
  type WeeklySampleConfig,
} from '@/lib/rag/monitor/sample';

const CONFIG: WeeklySampleConfig = { weekly_cap: 30, pilot_multiplier: 5, pilot_cap_share: 0.4, drift_fill_share: 0.5 };
const TENANT = 's:default';
const PILOT = '00000000-0000-4000-8000-0000000001a0';
const OTHER = '00000000-0000-4000-8000-0000000002b0';

const fp = (text: string) => createHash('sha256').update(text).digest('hex');

function rows(count: number, over: Partial<SampleCandidateRow> & { tag: string }): SampleCandidateRow[] {
  return Array.from({ length: count }, (_, i) => {
    const id = createHash('sha256').update(`${over.tag}-${i}`).digest('hex');
    const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
    return {
      id: uuid,
      trace_id: `trace-${over.tag}-${i}`,
      query_masked: `Synthetic question ${over.tag} ${i}`,
      query_fingerprint: fp(`${over.tag}-${i}`),
      language: over.language ?? 'xx',
      channel: over.channel ?? 'chat',
      user_id: over.user_id ?? OTHER,
      cluster: over.cluster ?? 'c-01',
    };
  });
}

const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);

describe('allocateStrata', () => {
  it('with 40 strata and cap 30 drops the lowest shares first and gives each remaining stratum one item', () => {
    const strata = Array.from({ length: 40 }, (_, i) => ({ key: `s${String(i).padStart(2, '0')}`, size: 100 - i }));
    const out = allocateStrata(strata, 30);
    expect(sum(out.values())).toBe(30);
    expect([...out.entries()].filter(([, n]) => n > 0).map(([key]) => key)).toEqual(strata.slice(0, 30).map((s) => s.key));
    for (const [, n] of out) expect(n === 0 || n === 1).toBe(true);
  });

  it('with 6 strata allocates by largest remainder, ties broken by stratum key', () => {
    const out = allocateStrata(
      [
        { key: 'f', size: 10 },
        { key: 'e', size: 10 },
        { key: 'd', size: 10 },
        { key: 'c', size: 10 },
        { key: 'b', size: 30 },
        { key: 'a', size: 30 },
      ],
      10,
    );
    // quotas 3, 3 and 1 x 4.
    expect(Object.fromEntries(out)).toEqual({ a: 3, b: 3, c: 1, d: 1, e: 1, f: 1 });
    const tie = allocateStrata(
      [
        { key: 'z', size: 1 },
        { key: 'y', size: 1 },
        { key: 'x', size: 1 },
        { key: 'w', size: 7 },
      ],
      5,
    );
    // quotas 3.5 and 0.5 x 3; every stratum keeps one, so w gets 2.
    expect(Object.fromEntries(tie)).toEqual({ w: 2, x: 1, y: 1, z: 1 });
    const remainder = allocateStrata(
      [
        { key: 'b', size: 5 },
        { key: 'a', size: 5 },
        { key: 'c', size: 10 },
      ],
      5,
    );
    // quotas 1.25, 1.25, 2.5: floors 1, 1, 2; the last item goes to c (0.5) before a and b (0.25).
    expect(Object.fromEntries(remainder)).toEqual({ a: 1, b: 1, c: 3 });
    const keyTie = allocateStrata(
      [
        { key: 'b', size: 3 },
        { key: 'a', size: 3 },
      ],
      3,
    );
    expect(Object.fromEntries(keyTie)).toEqual({ a: 2, b: 1 });
  });

  it('never exceeds a stratum size and takes everything under the cap', () => {
    expect(Object.fromEntries(allocateStrata([{ key: 'a', size: 2 }, { key: 'b', size: 50 }], 30))).toEqual({ a: 1, b: 29 });
    expect(Object.fromEntries(allocateStrata([{ key: 'a', size: 2 }, { key: 'b', size: 3 }, { key: 'c', size: 0 }], 30))).toEqual({ a: 2, b: 3, c: 0 });
    expect(sum(allocateStrata([{ key: 'a', size: 9 }], 0).values())).toBe(0);
  });

  it('is proportional on the 0.4, 0.3, 0.2, 0.1 shares', () => {
    const out = allocateStrata(
      [
        { key: 'c-01', size: 40 },
        { key: 'c-02', size: 30 },
        { key: 'c-03', size: 20 },
        { key: 'c-04', size: 10 },
      ],
      30,
    );
    expect(Object.fromEntries(out)).toEqual({ 'c-01': 12, 'c-02': 9, 'c-03': 6, 'c-04': 3 });
  });
});

describe('weeks and strata', () => {
  it('samples the ISO week before the one that holds now', () => {
    const window = sampleWindow(new Date('2026-11-25T12:00:00Z'));
    expect(window).toEqual({ since: '2026-11-16T00:00:00.000Z', until: '2026-11-23T00:00:00.000Z', week: '2026-W47' });
    expect(isoWeekLabel(new Date('2026-12-28T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekLabel(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01');
  });

  it('codes a stratum as cluster|language|channel within the strata pattern', () => {
    expect(stratumKey({ cluster: 'c-07', language: 'xx', channel: 'voice' })).toBe('c-07|xx|voice');
    expect(stratumKey({ cluster: null, language: null, channel: 'chat' })).toBe('none|und|chat');
    expect(stratumKey({ cluster: 'novel', language: 'xx-Yyyy', channel: 'embed' })).toMatch(/^[A-Za-z0-9_.:|-]{1,128}$/);
  });

  it('reads the sampling block of eval/config/monitor-alerts.json', () => {
    expect(loadSampleConfig()).toEqual(CONFIG);
    expect(() => loadSampleConfig({ sampling: { weekly_cap: 0 } })).toThrow();
  });
});

describe('planWeeklySample', () => {
  const base = { tenantKey: TENANT, week: '2026-W47', config: CONFIG, pilots: new Set<string>(), underCovered: new Set<string>(), queued: new Set<string>() };

  it('draws the cap proportionally across clusters with weights equal to the inverse inclusion probability', () => {
    const candidates = [
      ...rows(40, { tag: 'a', cluster: 'c-01' }),
      ...rows(30, { tag: 'b', cluster: 'c-02' }),
      ...rows(20, { tag: 'c', cluster: 'c-03' }),
      ...rows(10, { tag: 'd', cluster: 'c-04' }),
    ];
    const plan = planWeeklySample({ ...base, candidates });
    expect(plan.items).toHaveLength(30);
    const byCluster = (cluster: string) => plan.items.filter((item) => item.stratum.startsWith(`${cluster}|`));
    expect([byCluster('c-01').length, byCluster('c-02').length, byCluster('c-03').length, byCluster('c-04').length]).toEqual([12, 9, 6, 3]);
    for (const item of plan.items) {
      expect(item.source).toBe('representative');
      expect(item.sampling_weight).toBeCloseTo(10 / 3, 6);
    }
    // Horvitz-Thompson: the weights add back up to the population.
    expect(sum(plan.items.map((item) => item.sampling_weight))).toBeCloseTo(100, 6);
  });

  it('gives the same items for the same tenant and week and a different draw for another week', () => {
    const candidates = rows(200, { tag: 'w', cluster: 'c-01' });
    const ids = (week: string, tenantKey = TENANT) => planWeeklySample({ ...base, tenantKey, week, candidates }).items.map((item) => item.row.id);
    expect(ids('2026-W47')).toEqual(ids('2026-W47'));
    expect(ids('2026-W48')).not.toEqual(ids('2026-W47'));
    expect(ids('2026-W47', 'u:00000000-0000-4000-8000-0000000000c1')).not.toEqual(ids('2026-W47'));
  });

  it('pilot users: pilot candidates at weight 5 never exceed 12 of 30 items', () => {
    const pilotRows = rows(60, { tag: 'p', user_id: PILOT, cluster: 'c-02' });
    const plan = planWeeklySample({ ...base, pilots: new Set([PILOT]), candidates: [...rows(40, { tag: 'n', cluster: 'c-01' }), ...pilotRows] });
    const pilot = plan.items.filter((item) => item.source === 'pilot');
    expect(plan.items).toHaveLength(30);
    expect(pilot).toHaveLength(12);
    for (const item of pilot) {
      expect(item.row.user_id).toBe(PILOT);
      expect(item.sampling_weight).toBeCloseTo(60 / 12, 6);
    }
    expect(plan.by_source).toEqual({ representative: 18, pilot: 12, drift_fill: 0 });
  });

  it('pilot users: a few pilot rows are drawn at five times the rate of other rows', () => {
    const plan = planWeeklySample({
      ...base,
      pilots: new Set([PILOT]),
      candidates: [...rows(100, { tag: 'n', cluster: 'c-01' }), ...rows(5, { tag: 'p', user_id: PILOT, cluster: 'c-01' })],
    });
    // pilot mass 25 of 125: round(30 * 0.2) = 6, capped by the 5 pilot rows.
    const pilot = plan.items.filter((item) => item.source === 'pilot');
    expect(pilot).toHaveLength(5);
    expect(pilot.every((item) => item.sampling_weight === 1)).toBe(true);
    expect(plan.items.filter((item) => item.source === 'representative').every((item) => Math.abs(item.sampling_weight - 100 / 25) < 1e-6)).toBe(true);
  });

  it('drift_fill items from two under-covered clusters never exceed 15', () => {
    const plan = planWeeklySample({
      ...base,
      underCovered: new Set(['c-03', 'c-04']),
      candidates: [
        ...rows(40, { tag: 'a', cluster: 'c-01' }),
        ...rows(30, { tag: 'b', cluster: 'c-02' }),
        ...rows(30, { tag: 'c', cluster: 'c-03' }),
        ...rows(30, { tag: 'd', cluster: 'c-04' }),
      ],
    });
    const fill = plan.items.filter((item) => item.source === 'drift_fill');
    expect(fill).toHaveLength(15);
    expect(new Set(fill.map((item) => item.stratum.split('|')[0]))).toEqual(new Set(['c-03', 'c-04']));
    expect(plan.items).toHaveLength(30);
    expect(plan.items.filter((item) => item.source === 'representative').every((item) => /^c-0[12]\|/.test(item.stratum))).toBe(true);
  });

  it('excludes fingerprints already in the queue and counts them; one item per fingerprint', () => {
    const candidates = rows(10, { tag: 'q', cluster: 'c-01' });
    const duplicate = { ...candidates[1]!, id: '00000000-0000-4000-8000-0000000000dd', channel: 'voice' as const };
    const plan = planWeeklySample({ ...base, queued: new Set([candidates[0]!.query_fingerprint, candidates[2]!.query_fingerprint]), candidates: [...candidates, duplicate] });
    expect(plan.excluded_queued).toBe(2);
    const fps = plan.items.map((item) => item.row.query_fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
    expect(fps).not.toContain(candidates[0]!.query_fingerprint);
    expect(plan.items).toHaveLength(8);
  });

  it('counts by language', () => {
    const plan = planWeeklySample({ ...base, candidates: [...rows(6, { tag: 'x', language: 'xx' }), ...rows(4, { tag: 'y', language: null })] });
    expect(plan.by_language).toEqual({ xx: 6, und: 4 });
  });
});
