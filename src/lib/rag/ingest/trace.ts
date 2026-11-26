import { scopeKey, type TenantScope } from '../tenant/scope';
import { createTraceCollector, type TraceCollector } from '../trace/collector';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from '../trace/config';
import type { CollectedTrace } from '../trace/langfuse';
import { isSampled } from '../trace/sample';
import { scheduleAfterResponse } from '../trace/schedule';
import type { StageFailureReason, StageRecord, StageRunStatus } from '../types';
import type { IngestConfig } from './config';
import type { IngestResult, IngestTraceFacts, StageName } from './types';

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
  /** D-51 (Phase 3.2): set only while the switch that produces each one is on. */
  language_shares?: Record<string, number> | null;
  und_count?: number | null;
  ingest_fingerprint?: string | null;
  'scan.injection'?: string | null;
  'scan.hidden_text'?: string | null;
  'scan.links'?: string | null;
  approval_state?: string | null;
  'translation.translated'?: number | null;
  'translation.gaps'?: number | null;
}

type CleanValue = string | number | Record<string, number>;

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

const DETAIL_KEYS = [
  'parser_used',
  'pages',
  'chunk_count',
  'doc_type',
  'doc_type_origin',
  'fallback_reason',
  'outcome',
  'und_count',
  'ingest_fingerprint',
  'scan.injection',
  'scan.hidden_text',
  'scan.links',
  'approval_state',
  'translation.translated',
  'translation.gaps',
] as const;
const CODE = /^[A-Za-z0-9_.:@-]{1,64}$/;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_LANGUAGES = 32;

/**
 * D-51: whether a Phase 3.2 ingestion switch is on. The fingerprint is written on every run, but the trace shows it only then, so a run
 * with every switch off has exactly the attributes it had before the phase.
 */
export function phase32TraceOn(config: IngestConfig): boolean {
  return (
    config.languageAwareIngest === 'on' ||
    config.tableRowSerialization === true ||
    config.captionLanguage !== 'en' ||
    config.docTranslation === 'on' ||
    config.hiddenTextCheck !== 'off' ||
    config.ingestLinkCheck !== 'off' ||
    config.uploadApproval !== 'off' ||
    config.scopeTags === true ||
    config.supersessionDetect === 'on' ||
    config.effectiveDateLlmExtract === true
  );
}

/** The span attributes a stage's facts give (D-51): language shares and und count on enrich, scan outcomes on scan_injection, the rest on publish. */
export function phaseSpanDetail(stage: string, facts: IngestTraceFacts | null | undefined): IngestSpanDetail {
  if (!facts) return {};
  switch (stage) {
    case 'enrich':
      return {
        ...(facts.language_shares !== undefined ? { language_shares: facts.language_shares } : {}),
        ...(facts.und_count !== undefined ? { und_count: facts.und_count } : {}),
      };
    case 'scan_injection':
      return facts.scan
        ? { 'scan.injection': facts.scan.injection, 'scan.hidden_text': facts.scan.hidden_text, 'scan.links': facts.scan.links }
        : {};
    case 'publish':
      return {
        ...(facts.ingest_fingerprint !== undefined ? { ingest_fingerprint: facts.ingest_fingerprint } : {}),
        ...(facts.approval_state !== undefined ? { approval_state: facts.approval_state } : {}),
      };
    default:
      return {};
  }
}

/** Registry codes with a share in [0, 1] rounded to 2 decimals; anything else is dropped. */
function cleanShares(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const shares: Record<string, number> = {};
  for (const [code, share] of Object.entries(value as Record<string, unknown>).slice(0, MAX_LANGUAGES)) {
    if (!LANGUAGE_CODE.test(code) || typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) continue;
    shares[code] = Math.round(share * 100) / 100;
  }
  return shares;
}

function renderValue(value: CleanValue): string | number {
  if (typeof value !== 'object') return value;
  return Object.entries(value)
    .map(([code, share]) => `${code}=${share}`)
    .join(',');
}

/** The rules of a span: `key:value` per clean detail field, the language shares as `code=share` pairs. */
export function detailRules(detail: Record<string, CleanValue>): string[] {
  return Object.entries(detail).map(([key, value]) => `${key}:${renderValue(value)}`);
}

function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' && CODE.test(value) ? value : undefined;
}

/**
 * Keeps the fixed keys with a short code or a non-negative integer (the fingerprint only as a sha256 hex, the language shares only as
 * registry codes with numbers); anything else is dropped, so text cannot ride along.
 */
export function cleanDetail(detail: IngestSpanDetail | undefined): Record<string, CleanValue> {
  const clean: Record<string, CleanValue> = {};
  if (!detail) return clean;
  if (detail.language_shares !== undefined && detail.language_shares !== null) {
    const shares = cleanShares(detail.language_shares);
    if (shares !== undefined) clean.language_shares = shares;
  }
  for (const key of DETAIL_KEYS) {
    const value = detail[key];
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0) clean[key] = value;
      continue;
    }
    if (key === 'ingest_fingerprint') {
      if (typeof value === 'string' && FINGERPRINT.test(value)) clean[key] = value;
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
                rules: detailRules(detail),
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

export interface TranslationTraceInput {
  tenantKey: string;
  documentId: string;
  translated: number;
  gaps: number;
}

/**
 * D-51: one span `translation` per translation run after publish (the inline hook, or one slice of a queued translate job), with the
 * counts `translation.translated` and `translation.gaps` and nothing else. It runs only while RAG_DOC_TRANSLATION is on. Never throws.
 */
export function finishTranslationTrace(input: TranslationTraceInput, options: FinishIngestTraceOptions = {}): void {
  try {
    const collector = createTraceCollector({ profile: 'ingest', tenantKey: codeOf(input.tenantKey) ?? 'unscoped' });
    const entries: Array<{ record: StageRecord; detail: IngestSpanDetail }> = [];
    const trace: IngestTrace = {
      collector,
      owned: true,
      start: () => ({ end: () => undefined }),
      spans: () => entries.slice(),
    };
    const detail = cleanDetail({ 'translation.translated': input.translated, 'translation.gaps': input.gaps });
    const at = collector.now();
    const record = collector.record({ name: 'translation', status: 'ok', startedAt: at, endedAt: at, rules: detailRules(detail) });
    entries.push({ record, detail });
    const result: IngestResult = {
      status: 'ready',
      documentId: codeOf(input.documentId) ?? null,
      version: null,
      parserUsed: null,
      chunkCount: 0,
      warnings: [],
    };
    finishIngestTrace(trace, result, options);
  } catch {
    // tracing must never affect the run
  }
}
