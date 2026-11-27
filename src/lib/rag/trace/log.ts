import type { RefusalRecord } from '../refusal/types';
import type { RetrievalResult, StageRecord } from '../types';
import type { TraceCollector, TraceLanguages } from './collector';
import { sanitizeStageCounts } from './collector';

export interface TraceLogSink {
  (line: string): void;
}

const defaultSink: TraceLogSink = (line) => console.log(line);

const SAFE_CELL_KEY = /^[a-z0-9_.|-]{1,120}$/;
const REFUSAL_DECISION = new Set(['refuse', 'answer', 'not_applied']);
const REFUSAL_BASIS = new Set(['rerank_threshold', 'similarity_floor', 'none']);
const REFUSAL_REASON = /^[a-z][a-z0-9_]*$/;
const CACHE_STATES = new Set(['hit', 'miss', 'bypass']);
const DETECTOR_VERSION = /^[a-z_]{1,32}@[A-Za-z0-9._-]{1,64}$/;
const BACKENDS = new Set(['pgvector', 'weaviate', 'qdrant']);
const FALLBACK_REASONS = new Set(['backend_not_ready', 'backend_error', 'backend_slow', 'filter_unsupported']);

/** D-25: the search span's backend, fallback_reason and tenant_validation_dropped, from a fixed vocabulary only. */
function backendFieldsForLog(stage: StageRecord): Record<string, unknown> {
  if (stage.name !== 'search') return {};
  const attributes = stage.attributes ?? {};
  const backend = attributes.backend;
  if (typeof backend !== 'string' || !BACKENDS.has(backend)) return {};
  const reason = attributes.fallback_reason;
  const dropped = attributes.tenant_validation_dropped;
  return {
    backend,
    fallback_reason: typeof reason === 'string' && FALLBACK_REASONS.has(reason) ? reason : null,
    tenant_validation_dropped: typeof dropped === 'number' && Number.isInteger(dropped) && dropped >= 0 ? dropped : 0,
  };
}

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

function timingForLog(collector: TraceCollector): Record<string, unknown> {
  const timing = collector.timing();
  if (!timing) return {};
  return {
    ttft_ms: finiteOrNull(timing.ttft_ms),
    pre_generation_ms: finiteOrNull(timing.pre_generation_ms),
    cache: CACHE_STATES.has(timing.cache) ? timing.cache : 'bypass',
  };
}

/** LANG-10: the codes-only languages block, once the trace was finished with one. */
function languagesForLog(collector: TraceCollector): { languages?: TraceLanguages } {
  const block = collector.languages();
  if (!block) return {};
  return {
    languages: {
      query_language: block.query_language,
      query_language_confidence: block.query_language_confidence,
      chunk_languages: block.chunk_languages,
      answer_language: block.answer_language,
    },
  };
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
        ...backendFieldsForLog(stage),
      };
    }),
    ...(result.refusal ? { refusal: sanitizeRefusalForLog(result.refusal) } : {}),
    ...(result.injection ? { injectionFlagged: result.injection.flagged === true } : {}),
    ...timingForLog(collector),
    ...languagesForLog(collector),
  };
}

/** One structured line per request; the field list is fixed so query and chunk text can never reach the log sink. */
export function logRagTrace(collector: TraceCollector, result: RetrievalResult, sink: TraceLogSink = defaultSink): void {
  sink(`[RAG Trace] ${JSON.stringify(buildTraceLogPayload(collector, result))}`);
}