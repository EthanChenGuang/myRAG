import type { RetrievalResult } from '../types';
import type { TraceCollector } from './collector';
import type { TraceLogSink } from './log';

export interface FinishTraceOptions {
  sink?: TraceLogSink;
}

export function finishTrace(_collector: TraceCollector, _result: RetrievalResult, _options?: FinishTraceOptions): void {}
