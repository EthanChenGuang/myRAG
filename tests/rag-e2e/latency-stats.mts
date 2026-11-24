export interface StageStats {
  n: number;
  p50: number;
  p95: number;
}

export function percentile(_samples: readonly number[], _p: number): number {
  return Number.NaN;
}

export function perStage(_timings: ReadonlyArray<Readonly<Record<string, unknown>>>): Record<string, StageStats> {
  return {};
}
