import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import committed from '../../eval/config/monitor-alerts.json';
import { loadMonitorAlertsConfig, resetMonitorAlertsConfigCache } from '@/lib/rag/monitor/alerts-config';
import {
  histogramQuantile,
  LATENCY_BIN_EDGES_MS,
  mergeBins,
  pooledRate,
  psi,
  TOP_SCORE_BINS,
  twoProportionZ,
} from '@/lib/rag/monitor/stats';

afterEach(() => {
  vi.restoreAllMocks();
  resetMonitorAlertsConfigCache();
});

describe('twoProportionZ', () => {
  it('gives 4.36 for 38% of 50 against 12% of 200 (research "Statistics")', () => {
    expect(twoProportionZ(19, 50, 24, 200)).toBeCloseTo(4.36, 2);
  });

  it('is 0 for equal rates and null when a side is empty or the pooled rate is degenerate', () => {
    expect(twoProportionZ(10, 50, 40, 200)).toBe(0);
    expect(twoProportionZ(0, 0, 10, 100)).toBeNull();
    expect(twoProportionZ(0, 50, 0, 200)).toBeNull();
    expect(twoProportionZ(50, 50, 200, 200)).toBeNull();
  });
});

describe('pooledRate', () => {
  it('sums counts over n and returns null without rows', () => {
    expect(pooledRate([{ count: 6, n: 50 }, { count: 18, n: 150 }])).toBeCloseTo(0.12, 10);
    expect(pooledRate([])).toBeNull();
    expect(pooledRate([{ count: 0, n: 0 }])).toBeNull();
  });
});

describe('psi', () => {
  it('is 0 for two equal histograms and finite with an empty bin (0.5 smoothing)', () => {
    expect(psi([10, 20, 30, 40], [10, 20, 30, 40])).toBe(0);
    expect(psi([10, 20, 30], [20, 40, 60])).toBeLessThan(0.01);
    const value = psi([0, 50, 50], [40, 30, 30]);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0.25);
  });

  it('rejects histograms of different length', () => {
    expect(() => psi([1, 2], [1, 2, 3])).toThrow();
  });
});

describe('mergeBins', () => {
  it('turns 20 bins plus under and overflow into 10 plus under and overflow and keeps the total', () => {
    const bins = Array.from({ length: TOP_SCORE_BINS }, (_, i) => i + 1);
    const merged = mergeBins({ bins, underflow: 3, overflow: 7 }, 10);
    expect(merged.bins).toHaveLength(10);
    expect(merged.bins[0]).toBe(1 + 2);
    expect(merged.bins[9]).toBe(19 + 20);
    expect(merged.underflow).toBe(3);
    expect(merged.overflow).toBe(7);
    const total = (h: { bins: number[]; underflow: number; overflow: number }) =>
      h.bins.reduce((a, b) => a + b, 0) + h.underflow + h.overflow;
    expect(total(merged)).toBe(total({ bins, underflow: 3, overflow: 7 }));
  });

  it('refuses a target that does not divide the bin count', () => {
    expect(() => mergeBins({ bins: new Array(20).fill(1), underflow: 0, overflow: 0 }, 7)).toThrow();
  });
});

describe('histogramQuantile', () => {
  it('returns the upper edge of the bin holding the 95th percentile', () => {
    const bins = new Array(LATENCY_BIN_EDGES_MS.length + 1).fill(0);
    bins[2] = 90; // 150 ms
    bins[5] = 10; // 400 ms
    expect(histogramQuantile(bins, 0.95)).toBe(400);
    expect(histogramQuantile(bins, 0.5)).toBe(150);
    expect(histogramQuantile(bins, 0.9)).toBe(150);
  });

  it('returns null for an empty histogram and the last edge for the overflow bin', () => {
    const empty = new Array(LATENCY_BIN_EDGES_MS.length + 1).fill(0);
    expect(histogramQuantile(empty, 0.95)).toBeNull();
    const overflow = [...empty];
    overflow[overflow.length - 1] = 5;
    expect(histogramQuantile(overflow, 0.95)).toBe(LATENCY_BIN_EDGES_MS[LATENCY_BIN_EDGES_MS.length - 1]);
  });

  it('mirrors the latency bin edges and top-score bin count of the Pydantic contract', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'rag-sidecar/src/rag_sidecar/contracts/monitor.py'),
      'utf8',
    );
    const edges = /LATENCY_BIN_EDGES_MS[^=]*=\s*\(([^)]*)\)/.exec(source)?.[1] ?? '';
    const parsed = edges
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number);
    expect(parsed).toEqual([...LATENCY_BIN_EDGES_MS]);
    expect(Number(/TOP_SCORE_BINS\s*=\s*(\d+)/.exec(source)?.[1])).toBe(TOP_SCORE_BINS);
  });
});

describe('loadMonitorAlertsConfig', () => {
  it('returns the committed file', () => {
    const config = loadMonitorAlertsConfig();
    expect(config).not.toBeNull();
    expect(config?.rules.map((rule) => rule.id)).toEqual(committed.rules.map((rule) => rule.id));
    expect(config?.window_days).toEqual([1, 3, 7]);
    expect(loadMonitorAlertsConfig()).toBe(config);
  });

  it('returns null and logs one [Monitor] warning for a payload that fails the schema', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { ...committed, window_days: [3, 1] };
    expect(loadMonitorAlertsConfig(bad)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[Monitor\]/);
  });

  it('enforces the cross-field rules of the contract (drift rule bands equal the drift block)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = committed.rules.map((rule) => (rule.id === 'test_set_not_representative' ? { ...rule, alert: 0.5 } : rule));
    expect(loadMonitorAlertsConfig({ ...committed, rules })).toBeNull();
  });
});
