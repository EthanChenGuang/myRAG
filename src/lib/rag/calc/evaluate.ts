import type { CalcLimits, CalcResult } from '@/lib/rag-eval/contracts.generated';

export interface CalcContext {
  aliases: ReadonlySet<string>;
  limits?: CalcLimits;
}

export function evaluateCalc(_raw: unknown, _ctx: CalcContext): CalcResult {
  return { status: 'rejected', value: null, unit: null, steps: [], reject_reason: 'invalid_request' };
}
