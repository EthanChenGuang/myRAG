import type { RetrievalResult } from '../types';
import type { TraceCollector } from './collector';
import { logRagTrace, type TraceLogSink } from './log';

export interface FinishTraceOptions {
  sink?: TraceLogSink;
}

/** Log fallback for now; the sampled Langfuse export is added in plan 02-22 and keeps this as its fallback. Never throws. */
export function finishTrace(collector: TraceCollector, result: RetrievalResult, options: FinishTraceOptions = {}): void {
  try {
    logRagTrace(collector, result, options.sink);
  } catch {
    // tracing must never affect the request
  }
}
