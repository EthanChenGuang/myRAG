import type { RetrievalResult } from '../types';
import type { TraceCollector } from './collector';

export interface TraceLogSink {
  (line: string): void;
}

export function logRagTrace(_collector: TraceCollector, _result: RetrievalResult, _sink?: TraceLogSink): void {}
