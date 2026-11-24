import { scopeKey, type TenantScope } from '../tenant/scope';
import { createTraceCollector, type TraceCollector } from '../trace/collector';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from '../trace/config';
import type { CollectedTrace } from '../trace/langfuse';
import { isSampled } from '../trace/sample';
import { scheduleAfterResponse } from '../trace/schedule';
import type { StageFailureReason, StageRecord, StageRunStatus } from '../types';
import type { IngestResult, StageName } from './types';

/**
 * The only facts a span carries besides its name, status and latency. Every value is a number or a short
 * code, never text taken from a document.
 */
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
  /** The first call records the span; later calls do nothing. */
  end(result: IngestSpanEnd): void;
}

export interface IngestTrace {
  readonly collector: TraceCollector;
  /** True when this run created the collector and therefore finishes the trace. */
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

const DETAIL_KEYS = ['parser_used', 'pages', 'chunk_count', 'doc_type', 'doc_type_origin', 'fallback_reason', 'outcome'] as const;
const CODE = /^[A-Za-z0-9_.:@-]{1,64}$/;

function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' && CODE.test(value) ? value : undefined;
}

/** Keeps the fixed keys with a short code or a non-negative integer; anything else is dropped, so text cannot ride along. */
function cleanDetail(detail: IngestSpanDetail | undefined): Record<string, string | number> {
  const clean: Record<string, string | number> = {};
  if (!detail) return clean;
  for (const key of DETAIL_KEYS) {
    const value = detail[key];
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0) clean[key] = value;
      continue;
    }
    const code = codeOf(value);
    if (code !== undefined) clean[key] = code;
  }
  return clean;
}

function tenantKeyOf(scope: TenantScope): string {
  try {
    return scopeKey(scope);
  } catch {
    return 'unscoped';
  }
}

/**
 * One collector per ingest run, with profile `ingest` and the tenant key of the scope. A collector passed
 * in by the caller is used as is and finished by the caller. Never throws: a run is not affected by tracing.
 */
export function createIngestTrace(scope: TenantScope, existing?: TraceCollector): IngestTrace | null {
  try {
    const collector = existing ?? createTraceCollector({ profile: 'ingest', tenantKey: tenantKeyOf(scope) });
    const entries: Array<{ record: StageRecord; detail: IngestSpanDetail }> = [];
    return {
      collector,
      owned: existing === undefined,
      start(stage) {
        const startedAt = collector.now();
        let ended = false;
        return {
          end(result) {
            if (ended) return;
            ended = true;
            try {
              const detail = cleanDetail(result.detail);
              const record = collector.record({
                name: stage,
                status: result.status,
                ...(result.reason !== undefined ? { reason: result.reason } : {}),
                startedAt,
                endedAt: collector.now(),
                rules: Object.entries(detail).map(([key, value]) => `${key}:${value}`),
              });
              entries.push({ record, detail });
            } catch {
              // tracing must never affect the run
            }
          },
        };
      },
      spans: () => entries.slice(),
    };
  } catch {
    return null;
  }
}

/** The fixed field list of the fallback line: ids, status, and per stage name, status, reason, latency and the span facts. */
export function buildIngestTraceLogPayload(trace: IngestTrace, result: IngestResult): Record<string, unknown> {
  return {
    traceId: trace.collector.traceId,
    tenantKey: trace.collector.tenantKey,
    profile: trace.collector.profile,
    status: result.status,
    reason: codeOf(result.reason) ?? null,
    stages: trace.spans().map(({ record, detail }) => ({
      name: record.name,
      status: record.status,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      latency_ms: record.latency_ms,
      ...cleanDetail(detail),
    })),
  };
}

/** One structured line per ingestion; the field list is fixed so document text can never reach the log sink. */
export function logIngestTrace(trace: IngestTrace, result: IngestResult, sink: IngestTraceLogSink = (line) => console.log(line)): void {
  sink(`[Ingest Trace] ${JSON.stringify(buildIngestTraceLogPayload(trace, result))}`);
}

function collect(trace: IngestTrace, result: IngestResult): CollectedTrace {
  const { collector } = trace;
  const stages = collector.stages();
  const endedAt = stages.reduce((latest, stage) => Math.max(latest, stage.endedAt), collector.startedAt);
  return {
    traceId: collector.traceId,
    tenantKey: collector.tenantKey,
    profile: collector.profile,
    status: result.status,
    reason: codeOf(result.reason) ?? result.status,
    tags: ['rag-ingest', `profile:${collector.profile}`, `tenant:${collector.tenantKey}`],
    startedAt: collector.startedAt,
    endedAt,
    stages,
  };
}

/**
 * Sampled runs are exported through the Phase 2 Langfuse path after the response; every other run, and any
 * export failure, writes the single `[Ingest Trace]` line. An ingest trace is sampled with the trace prefix
 * only: it never becomes a review candidate and never carries content. Never throws.
 */
export function finishIngestTrace(trace: IngestTrace, result: IngestResult, options: FinishIngestTraceOptions = {}): void {
  try {
    const config = options.config ?? readLangfuseConfig();
    if (!isLangfuseUsable(config) || !isSampled(trace.collector.traceId, config.sampleRate, 'trace')) {
      logIngestTrace(trace, result, options.sink);
      return;
    }
    scheduleAfterResponse(async () => {
      try {
        const { exportTrace } = await import('../trace/langfuse');
        await exportTrace(collect(trace, result), {
          config,
          ...(options.flushTimeoutMs !== undefined ? { flushTimeoutMs: options.flushTimeoutMs } : {}),
        });
      } catch {
        try {
          logIngestTrace(trace, result, options.sink);
        } catch {
          // tracing must never affect the run
        }
      }
    });
  } catch {
    // tracing must never affect the run
  }
}
