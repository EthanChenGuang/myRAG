import type { CalcRequest, CalcResult, CalcTrace } from '@/lib/rag-eval/contracts.generated';

/** A trailing block the extractor could not use (D-72); the check turns it into not_verified with trace_invalid. */
export interface CalcInvalidMarker {
  invalid: string;
  anchor_offset: number | null;
}

/** A parsed trailing block as the extractor hands it over (plan 05.2.1-10); result is filled by the check. */
export interface CalcBlockTrace {
  origin: 'trailing_block';
  request: CalcRequest;
  anchor_offset?: number | null;
  result?: CalcResult | null;
}

export interface CalcTraceHolder {
  record(trace: CalcTrace): void;
  recordBlock(entry: CalcBlockTrace | CalcInvalidMarker): void;
  traces(): CalcTrace[];
  invalid(): CalcInvalidMarker[];
  markToolCall(textOffset: number): void;
}

export function createCalcTraceHolder(): CalcTraceHolder {
  return {
    record() {},
    recordBlock() {},
    traces: () => [],
    invalid: () => [],
    markToolCall() {},
  };
}
