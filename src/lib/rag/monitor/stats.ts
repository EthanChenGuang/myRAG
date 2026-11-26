export const TOP_SCORE_BINS = 0;
export const LATENCY_BIN_EDGES_MS: readonly number[] = [];
export interface BinnedHistogram { bins: number[]; underflow: number; overflow: number }
export function pooledRate(_rows: { count: number; n: number }[]): number | null { return NaN; }
export function twoProportionZ(_x1: number, _n1: number, _x2: number, _n2: number): number | null { return NaN; }
export function psi(_actual: number[], _expected: number[]): number { return NaN; }
export function mergeBins(h: BinnedHistogram, _target: number): BinnedHistogram { return h; }
export function histogramQuantile(_bins: number[], _q: number): number | null { return NaN; }
