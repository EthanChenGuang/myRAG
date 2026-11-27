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

/**
 * Per-request store of the calculations of one answer (D-65, D-72, D-95). Its methods are closures, so
 * `holder.recordBlock` can be passed on unbound as the extractor's onTrace callback.
 */
export interface CalcTraceHolder {
  record(trace: CalcTrace): void;
  recordBlock(entry: CalcBlockTrace | CalcInvalidMarker): void;
  traces(): CalcTrace[];
  invalid(): CalcInvalidMarker[];
  /** The visible-text offset at which a tool step ended; anchors every tool trace recorded since the last mark. */
  markToolCall(textOffset: number): void;
}

function offset(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createCalcTraceHolder(): CalcTraceHolder {
  const traces: CalcTrace[] = [];
  const invalid: CalcInvalidMarker[] = [];
  return {
    record(trace) {
      traces.push({ origin: trace.origin, request: trace.request, result: trace.result ?? null, anchor_offset: offset(trace.anchor_offset) });
    },
    recordBlock(entry) {
      if ('invalid' in entry) {
        invalid.push({ invalid: String(entry.invalid), anchor_offset: offset(entry.anchor_offset) });
        return;
      }
      traces.push({ origin: 'trailing_block', request: entry.request, anchor_offset: offset(entry.anchor_offset), result: entry.result ?? null });
    },
    traces: () => traces.map((trace) => ({ ...trace })),
    invalid: () => invalid.map((marker) => ({ ...marker })),
    markToolCall(textOffset) {
      const at = offset(textOffset);
      if (at === null) return;
      for (const trace of traces) {
        if (trace.origin === 'tool' && trace.anchor_offset === null) trace.anchor_offset = at;
      }
    },
  };
}
