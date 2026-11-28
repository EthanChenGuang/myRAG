import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { needsRewrite } from '@/lib/rag/query/rewrite-gate';
import { GATE_FIXTURES } from './rewrite-gate.fixtures';

const WARM_UP_CALLS = 1_000;
const MEASURED_CALLS = 10_000;
const P99_BUDGET_MS = 1;

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

describe('needsRewrite latency (D-27)', () => {
  it('stays under 1 ms at p99 over the fixture table', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    const rows = GATE_FIXTURES.map((f) => ({ q: f.q, ctx: { ...f.ctx, now } }));

    for (let i = 0; i < WARM_UP_CALLS; i += 1) {
      const row = rows[i % rows.length];
      needsRewrite(row.q, row.ctx);
    }

    const durations = new Array<number>(MEASURED_CALLS);
    for (let i = 0; i < MEASURED_CALLS; i += 1) {
      const row = rows[i % rows.length];
      const start = performance.now();
      needsRewrite(row.q, row.ctx);
      durations[i] = performance.now() - start;
    }
    durations.sort((a, b) => a - b);

    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);
    console.log('[Query Layer] rewrite gate latency (ms):', {
      p50: Number(p50.toFixed(4)),
      p95: Number(p95.toFixed(4)),
      p99: Number(p99.toFixed(4)),
    });
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  });
});
