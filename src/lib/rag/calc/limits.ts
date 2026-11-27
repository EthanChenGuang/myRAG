import type { CalcLimits } from '@/lib/rag-eval/contracts.generated';

export type { CalcLimits };

export function parseCalcLimits(raw: unknown): CalcLimits {
  return raw as CalcLimits;
}

export function calcLimits(): CalcLimits {
  return {} as CalcLimits;
}

export function calcLimitsVersion(): string {
  return '';
}
