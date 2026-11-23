import type { RetrievalResult } from '../types';
import type { TraceCollector } from './collector';

export interface TraceLogSink {
  (line: string): void;
}

const defaultSink: TraceLogSink = (line) => console.log(line);

export function buildTraceLogPayload(collector: TraceCollector, result: RetrievalResult) {
  return {
    traceId: collector.traceId,
    tenantKey: collector.tenantKey,
    profile: collector.profile,
    status: result.status,
    reason: result.reason,
    stages: collector.stages().map((stage) => ({
      name: stage.name,
      status: stage.status,
      ...(stage.reason !== undefined ? { reason: stage.reason } : {}),
      latency_ms: stage.latency_ms,
      candidates_in: stage.candidates_in,
      candidates_out: stage.candidates_out,
      rules: stage.rules,
    })),
  };
}

/** One structured line per request; the field list is fixed so query and chunk text can never reach the log sink. */
export function logRagTrace(collector: TraceCollector, result: RetrievalResult, sink: TraceLogSink = defaultSink): void {
  sink(`[RAG Trace] ${JSON.stringify(buildTraceLogPayload(collector, result))}`);
}
