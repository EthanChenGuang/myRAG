import type { RetrievalResult } from '../types';
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
}

const BASE_TAGS = ['rag-pipeline'];
const REVIEW_TAG = 'review_candidate';

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
    tags: [...BASE_TAGS, `profile:${collector.profile}`, `tenant:${collector.tenantKey}`, ...(reviewCandidate ? [REVIEW_TAG] : [])],
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
