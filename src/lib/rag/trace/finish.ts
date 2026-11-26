import { readFeedbackLoopConfig } from '../feedback-loop/config';
import type { LogContext, RetrievalResult } from '../types';
import type { TraceCollector } from './collector';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from './config';
import type { CollectedTrace } from './langfuse';
import { logRagTrace, type TraceLogSink } from './log';
import { isSampled } from './sample';
import { scheduleAfterResponse } from './schedule';

export interface FinishTraceOptions {
  sink?: TraceLogSink;
  /** Query text, exported only when LANGFUSE_CAPTURE_CONTENT is true and always after masking. */
  query?: string;
  config?: LangfuseConfig;
  flushTimeoutMs?: number;
  /** Who asked and through which channel; without a channel no retrieval log row is written. */
  logContext?: LogContext;
  /** Query text read only by the retrieval log (language detection, masked_query); never exported to Langfuse. */
  logQuery?: string;
}

const LOGGED_PROFILES: ReadonlySet<string> = new Set(['chat', 'embed', 'voice']);

function totalLatency(collector: TraceCollector): number {
  const endedAt = collector.stages().reduce((latest, stage) => Math.max(latest, stage.endedAt), collector.startedAt);
  return Math.max(0, endedAt - collector.startedAt);
}

/** D-05: only user questions with a channel, never ghost chats; the row is built in the task so the route's outcome is final. */
function scheduleRetrievalLog(collector: TraceCollector, result: RetrievalResult, options: FinishTraceOptions): void {
  const context = options.logContext;
  if (!context || context.skip === true || !context.channel) return;
  if (!LOGGED_PROFILES.has(collector.profile)) return;
  if (typeof context.chatId === 'string' && context.chatId.startsWith('ghost-')) return;
  const mode = readFeedbackLoopConfig().retrievalLog;
  if (mode === 'off') return;
  scheduleAfterResponse(async () => {
    try {
      const { buildRetrievalLogRow, writeRetrievalLog } = await import('../feedback-loop/retrieval-log');
      const row = buildRetrievalLogRow({
        result,
        tenantKey: collector.tenantKey,
        stageLatency: collector.toStageLatency(),
        latencyMs: totalLatency(collector),
        logContext: context,
        mode,
        query: options.logQuery ?? options.query,
      });
      await writeRetrievalLog(row, { expectedTenantKey: collector.tenantKey });
    } catch {
      // the retrieval log must never affect the request or the trace
    }
  });
}

const BASE_TAGS = ['rag-pipeline'];

function collect(
  collector: TraceCollector,
  result: RetrievalResult,
  config: LangfuseConfig,
  query: string | undefined,
  reviewCandidate: boolean,
): CollectedTrace {
  const stages = collector.stages();
  const endedAt = stages.reduce((latest, stage) => Math.max(latest, stage.endedAt), collector.startedAt);
  const trace: CollectedTrace = {
    traceId: collector.traceId,
    tenantKey: collector.tenantKey,
    profile: collector.profile,
    status: result.status,
    reason: result.reason,
    tags: [...BASE_TAGS, `profile:${collector.profile}`, `tenant:${collector.tenantKey}`],
    startedAt: collector.startedAt,
    endedAt,
    stages,
  };
  if (reviewCandidate) {
    trace.review = { ...(query !== undefined ? { query } : {}), ...collector.reviewContent() };
  } else if (config.captureContent) {
    trace.content = {
      ...(query !== undefined ? { query } : {}),
      chunks: result.kept.map((chunk) => ({
        document_name: chunk.document_name,
        content: chunk.content,
        similarity: chunk.similarity,
        rank: chunk.rank,
      })),
    };
  }
  return trace;
}

/** Sampled requests are replayed to Langfuse after the response; everything else, and any export failure, writes the single `[RAG Trace]` line. Never throws. */
export function finishTrace(collector: TraceCollector, result: RetrievalResult, options: FinishTraceOptions = {}): void {
  try {
    scheduleRetrievalLog(collector, result, options);
  } catch {
    // the retrieval log must never affect the request or the trace
  }
  try {
    const config = options.config ?? readLangfuseConfig();
    const traceSampled = isSampled(collector.traceId, config.sampleRate, 'trace');
    const reviewCandidate = isSampled(collector.traceId, config.reviewSampleRate, 'review');
    if (!isLangfuseUsable(config) || (!traceSampled && !reviewCandidate)) {
      logRagTrace(collector, result, options.sink);
      return;
    }
    scheduleAfterResponse(async () => {
      try {
        const { exportTrace } = await import('./langfuse');
        // Built when the export runs so content recorded after the stream finished is included.
        const trace = collect(collector, result, config, options.query, reviewCandidate);
        await exportTrace(trace, { config, ...(options.flushTimeoutMs !== undefined ? { flushTimeoutMs: options.flushTimeoutMs } : {}) });
      } catch {
        try {
          logRagTrace(collector, result, options.sink);
        } catch {
          // tracing must never affect the request
        }
      }
    });
  } catch {
    // tracing must never affect the request
  }
}
