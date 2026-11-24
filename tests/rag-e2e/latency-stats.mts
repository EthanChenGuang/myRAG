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
