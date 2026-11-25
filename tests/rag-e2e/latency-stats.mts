// Latency numbers for the ingestion target (D-45): nearest-rank percentiles, so every reported value is a measured sample.

export interface StageStats {
  n: number;
  p50: number;
  p95: number;
}

/** Nearest-rank percentile: the smallest sample with at least `fraction` of the samples at or below it. */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new Error('percentile of an empty sample');
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`percentile fraction must be in (0, 1], got ${fraction}`);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[rank - 1] as number;
}

export function summarize(samples: readonly number[]): StageStats {
  return { n: samples.length, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}

/** p50 and p95 per stage over many runs; a run without a stage (or with a non-numeric value) does not count as zero. */
export function perStage(timings: ReadonlyArray<Readonly<Record<string, unknown>>>): Record<string, StageStats> {
  const byStage = new Map<string, number[]>();
  for (const run of timings) {
    for (const [stage, value] of Object.entries(run)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const samples = byStage.get(stage) ?? [];
      samples.push(value);
      byStage.set(stage, samples);
    }
  }
  const stats: Record<string, StageStats> = {};
  for (const [stage, samples] of byStage) stats[stage] = summarize(samples);
  return stats;
}

/** One upload: route time to the 202, 202 to the first non-queued status read, 202 to the ready read, and the ledger timings. */
export interface LatencyRun {
  routeMs: number;
  pickupMs: number;
  totalMs: number;
  timings: Readonly<Record<string, unknown>>;
}

/** The steps of the RESEARCH "Latency Budget" table, with the p95 budget each one was given. */
export const LATENCY_BUDGET_STEPS = [
  { key: 'route', name: 'Route: identify, hash, store original, enqueue, 202', budget: '3 s' },
  { key: 'pickup', name: 'Pickup (wake, else poll 2 s + jitter)', budget: '3 s' },
  { key: 'preflight', name: 'Preflight L1', budget: '0.5 s' },
  { key: 'parse', name: 'Parse', budget: '25 s real / ~0 s fake' },
  { key: 'check', name: 'Check + merge + cache write', budget: '2 s' },
  { key: 'advance', name: 'advance calls (dedup ... publish)', budget: '15 s real / <= 5 s fake' },
  { key: 'total', name: 'Total, 202 to ready status read', budget: '60 s target' },
] as const;

const OWN_STEPS = new Set(['preflight', 'parse', 'check']);

/** Groups one run under the budget steps; every other ledger stage is an advance call. A step the run never had is left out. */
export function budgetSteps(run: LatencyRun): Record<string, number> {
  const steps: Record<string, number> = { route: run.routeMs, pickup: run.pickupMs };
  let advance: number | null = null;
  for (const [stage, value] of Object.entries(run.timings)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (OWN_STEPS.has(stage)) steps[stage] = value;
    else advance = (advance ?? 0) + value;
  }
  if (advance !== null) steps.advance = advance;
  steps.total = run.totalMs;
  return steps;
}

function ms(value: number): string {
  return `${Math.round(value)} ms`;
}

export function formatLatencyReport(title: string, runs: readonly LatencyRun[]): string {
  const steps = perStage(runs.map(budgetSteps));
  const stages = perStage(runs.map((run) => run.timings));
  const lines = [title, '  step | n | p50 | p95 | budget p95'];
  for (const step of LATENCY_BUDGET_STEPS) {
    const stats = steps[step.key];
    if (stats) lines.push(`  ${step.name} | ${stats.n} | ${ms(stats.p50)} | ${ms(stats.p95)} | ${step.budget}`);
  }
  lines.push('  ledger stage (ingestion_jobs.timings) | n | p50 | p95');
  for (const [stage, stats] of Object.entries(stages).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${stage} | ${stats.n} | ${ms(stats.p50)} | ${ms(stats.p95)}`);
  }
  return lines.join('\n');
}
