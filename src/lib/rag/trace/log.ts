import type { RefusalRecord } from '../refusal/types';
import type { RetrievalResult } from '../types';
import type { TraceCollector } from './collector';
import { sanitizeStageCounts } from './collector';

export interface TraceLogSink {
  (line: string): void;
}

const defaultSink: TraceLogSink = (line) => console.log(line);

const SAFE_CELL_KEY = /^[a-z0-9_.|-]{1,120}$/;
const REFUSAL_DECISION = new Set(['refuse', 'answer', 'not_applied']);
const REFUSAL_BASIS = new Set(['rerank_threshold', 'similarity_floor', 'none']);
const REFUSAL_REASON = /^[a-z][a-z0-9_]*$/;
const DETECTOR_VERSION = /^[a-z_]{1,32}@[A-Za-z0-9._-]{1,64}$/;

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function sanitizeRefusalForLog(refusal: RefusalRecord): Record<string, unknown> | undefined {
  if (!REFUSAL_DECISION.has(refusal.decision) || !REFUSAL_BASIS.has(refusal.basis)) return undefined;

  const payload: Record<string, unknown> = {
    decision: refusal.decision,
    basis: refusal.basis,
    reason:
      refusal.reason === null
        ? null
        : typeof refusal.reason === 'string' && REFUSAL_REASON.test(refusal.reason)
          ? refusal.reason
          : null,
    topScore: finiteOrNull(refusal.topScore),
    threshold: finiteOrNull(refusal.threshold),
  };

  const cellKey = refusal.cellKey;
  if (typeof cellKey === 'string' && SAFE_CELL_KEY.test(cellKey)) {
    payload.cellKey = cellKey;
  }

  return payload;
}

export function buildTraceLogPayload(collector: TraceCollector, result: RetrievalResult) {
  return {
    traceId: collector.traceId,
    tenantKey: collector.tenantKey,
    profile: collector.profile,
    status: result.status,
    reason: result.reason,
    stages: collector.stages().map((stage) => {
      const counts = stage.counts ? sanitizeStageCounts(stage.counts) : undefined;
      return {
        name: stage.name,
        status: stage.status,
        ...(stage.reason !== undefined ? { reason: stage.reason } : {}),
        latency_ms: stage.latency_ms,
        candidates_in: stage.candidates_in,
        candidates_out: stage.candidates_out,
        rules: stage.rules,
        ...(counts !== undefined ? { counts } : {}),
        ...(stage.versions ? { versions: stage.versions.filter((version) => DETECTOR_VERSION.test(version)) } : {}),
      };
    }),
    ...(result.refusal ? { refusal: sanitizeRefusalForLog(result.refusal) } : {}),
    ...(result.injection ? { injectionFlagged: result.injection.flagged === true } : {}),
  };
}

/** One structured line per request; the field list is fixed so query and chunk text can never reach the log sink. */
export function logRagTrace(collector: TraceCollector, result: RetrievalResult, sink: TraceLogSink = defaultSink): void {
  sink(`[RAG Trace] ${JSON.stringify(buildTraceLogPayload(collector, result))}`);
}