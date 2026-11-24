import type { TenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { LangfuseConfig } from '../trace/config';
import type { StageFailureReason, StageRecord, StageRunStatus } from '../types';
import type { IngestResult, StageName } from './types';

export interface IngestSpanDetail {
  parser_used?: string | null;
  pages?: number | null;
  chunk_count?: number | null;
  doc_type?: string | null;
  doc_type_origin?: string | null;
  fallback_reason?: string | null;
  outcome?: string | null;
}

export interface IngestSpanEnd {
  status: StageRunStatus;
  reason?: StageFailureReason | 'disabled';
  detail?: IngestSpanDetail;
}

export interface IngestSpan {
  end(result: IngestSpanEnd): void;
}

export interface IngestTrace {
  readonly collector: TraceCollector;
  readonly owned: boolean;
  start(stage: StageName): IngestSpan;
  spans(): Array<{ record: StageRecord; detail: IngestSpanDetail }>;
}

export interface IngestTraceLogSink {
  (line: string): void;
}

export interface FinishIngestTraceOptions {
  sink?: IngestTraceLogSink;
  config?: LangfuseConfig;
  flushTimeoutMs?: number;
}

export function createIngestTrace(_scope: TenantScope, _existing?: TraceCollector): IngestTrace | null {
  return null;
}

export function finishIngestTrace(_trace: IngestTrace, _result: IngestResult, _options: FinishIngestTraceOptions = {}): void {}
