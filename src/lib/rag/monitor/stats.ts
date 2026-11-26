/** Mirrors TOP_SCORE_BINS of rag_sidecar/contracts/monitor.py: equal bins over 0 to 1 plus underflow and overflow. */
export const TOP_SCORE_BINS = 20;

/** Mirrors LATENCY_BIN_EDGES_MS of rag_sidecar/contracts/monitor.py; the last bin holds everything above the last edge. */
export const LATENCY_BIN_EDGES_MS: readonly number[] = [
  50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 20000,
];

export interface BinnedHistogram {
  bins: number[];
  underflow: number;
  overflow: number;
}

export interface CountOverN {
  count: number;
  n: number;
}

export function pooledRate(rows: readonly CountOverN[]): number | null {
  let count = 0;
  let n = 0;
  for (const row of rows) {
    count += row.count;
    n += row.n;
  }
  return n > 0 ? count / n : null;
}

/** Pooled two-proportion z of p1 = x1/n1 against p2 = x2/n2; null when it is undefined. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const pooled = (x1 + x2) / (n1 + n2);
  const variance = pooled * (1 - pooled) * (1 / n1 + 1 / n2);
  if (!(variance > 0)) return null;
  return (x1 / n1 - x2 / n2) / Math.sqrt(variance);
}

/** Population stability index of two count histograms; every bin is smoothed by 0.5 so an empty bin stays finite. */
export function psi(actual: readonly number[], expected: readonly number[]): number {
  if (actual.length !== expected.length || actual.length === 0) {
    throw new Error('psi needs two histograms of the same, non-zero length');
  }
  const k = actual.length;
  const actualTotal = actual.reduce((sum, value) => sum + value, 0) + 0.5 * k;
  const expectedTotal = expected.reduce((sum, value) => sum + value, 0) + 0.5 * k;
  let total = 0;
  for (let i = 0; i < k; i += 1) {
    const a = (actual[i] + 0.5) / actualTotal;
    const e = (expected[i] + 0.5) / expectedTotal;
    total += (a - e) * Math.log(a / e);
  }
  return Math.abs(total) < 1e-15 ? 0 : total;
}

/** Merges adjacent bins into `target` bins; underflow and overflow are kept as they are. */
export function mergeBins(histogram: BinnedHistogram, target: number): BinnedHistogram {
  const size = histogram.bins.length;
  if (!Number.isInteger(target) || target < 1 || size % target !== 0) {
    throw new Error('mergeBins needs a target that divides the bin count');
  }
  const width = size / target;
  const bins = new Array<number>(target).fill(0);
  histogram.bins.forEach((value, index) => {
    bins[Math.floor(index / width)] += value;
  });
  return { bins, underflow: histogram.underflow, overflow: histogram.overflow };
}

/**
 * The upper edge of the bin holding quantile q of a latency histogram; null when it is empty.
 * A quantile in the overflow bin returns the last edge, a lower bound of the true value.
 */
export function histogramQuantile(
  bins: readonly number[],
  q: number,
  edges: readonly number[] = LATENCY_BIN_EDGES_MS,
): number | null {
  const total = bins.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let cumulative = 0;
  for (let i = 0; i < bins.length; i += 1) {
    cumulative += bins[i];
    if (cumulative >= rank) return edges[Math.min(i, edges.length - 1)];
  }
  return edges[edges.length - 1];
}
