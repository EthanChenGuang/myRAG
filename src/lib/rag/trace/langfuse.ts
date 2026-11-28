import { randomBytes } from 'node:crypto';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import { TraceFlags } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { isLangfuseUsable, type LangfuseConfig } from './config';
import { maskPII } from './mask';
import type { StageRecord } from '../types';
import type { TraceTiming } from './collector';

const DEFAULT_FLUSH_TIMEOUT_MS = 4000;
const EXPORT_REQUEST_TIMEOUT_SECONDS = 3;
// Langfuse drops null attributes, so a stage without a candidate count exports -1 to keep the attribute present.
const NOT_APPLICABLE = -1;
const MAX_REVIEW_CONTEXT_CHARS = 40_000;
const REVIEW_TAG = 'review_candidate';

/** A stage plus optional scalar span metadata (codes and numbers only, never content). */
export type TraceStage = StageRecord & { attributes?: Record<string, string | number | boolean> };

export interface CollectedTrace {
  /** Root observation name; defaults to rag-request. */
  name?: string;
  traceId: string;
  tenantKey: string;
  profile: string;
  status: string;
  reason: string;
  tags: string[];
  startedAt: number;
  endedAt: number;
  stages: TraceStage[];
  review?: { query?: string; answer?: string; context?: string; model?: string };
  /** D-25: numbers and one fixed word, read from the collector when the export is built. */
  timing?: TraceTiming;
  content?: { query?: string; chunks?: Array<{ document_name: string; content: string; similarity: number; rank: number }> };
}

export interface ExportTraceOptions {
  config: LangfuseConfig;
  flushTimeoutMs?: number;
}

interface ActiveExporter {
  signature: string;
  processor: LangfuseSpanProcessor;
  provider: BasicTracerProvider;
}

let active: ActiveExporter | null = null;

function signatureOf(config: LangfuseConfig): string {
  return `${config.baseUrl}\n${config.publicKey}\n${config.secretKey}`;
}

function ensureExporter(config: LangfuseConfig): ActiveExporter {
  const signature = signatureOf(config);
  if (active && active.signature === signature) return active;
  if (active) void active.provider.shutdown().catch(() => undefined);
  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
    exportMode: 'batched',
    timeout: EXPORT_REQUEST_TIMEOUT_SECONDS,
    mask: ({ data }) => maskPII(data),
    shouldExportSpan: () => true,
    mediaUploadEnabled: false,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  active = { signature, processor, provider };
  return active;
}

export function hasLangfuseProcessor(): boolean {
  return active !== null;
}

export async function resetLangfuseForTests(): Promise<void> {
  const current = active;
  active = null;
  setLangfuseTracerProvider(null);
  if (current) await current.provider.shutdown().catch(() => undefined);
}

function stageMetadata(stage: TraceStage): Record<string, unknown> {
  return {
    ...(stage.attributes ?? {}),
    latency_ms: stage.latency_ms,
    candidates_in: stage.candidates_in ?? NOT_APPLICABLE,
    candidates_out: stage.candidates_out ?? NOT_APPLICABLE,
    status: stage.status,
    rules: stage.rules,
    ...(stage.reason !== undefined ? { reason: stage.reason } : {}),
  };
}

function levelFor(stage: StageRecord): 'DEFAULT' | 'WARNING' | 'ERROR' {
  if (stage.status === 'error' || stage.status === 'timeout' || stage.status === 'aborted') return 'ERROR';
  if (stage.status === 'skipped') return 'WARNING';
  return 'DEFAULT';
}

async function raceFlush(flush: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('langfuse flush timed out')), timeoutMs);
  });
  try {
    await Promise.race([flush, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Replays the collected stages as one trace (a root plus one span per stage) on the isolated provider, then flushes within the time box. Throws on failure so the caller can fall back to the log line. */
export async function exportTrace(trace: CollectedTrace, options: ExportTraceOptions): Promise<void> {
  const { config, flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS } = options;
  if (!isLangfuseUsable(config)) throw new Error('langfuse is not enabled');
  const { provider } = ensureExporter(config);

  const common = {
    'user.id': trace.tenantKey,
    'langfuse.trace.tags': trace.review ? [...trace.tags, REVIEW_TAG] : trace.tags,
    'langfuse.trace.metadata.tenantKey': trace.tenantKey,
  };

  const content = trace.content;
  const review = trace.review;
  const timing = trace.timing;
  const rootAttributes = {
    metadata: {
      tenantKey: trace.tenantKey,
      profile: trace.profile,
      status: trace.status,
      reason: trace.reason,
      ...(review?.context !== undefined ? { context: maskPII(review.context).slice(0, MAX_REVIEW_CONTEXT_CHARS) } : {}),
      ...(review?.model !== undefined ? { model: review.model } : {}),
      ...(timing?.ttft_ms !== undefined ? { ttft_ms: timing.ttft_ms } : {}),
      ...(timing?.pre_generation_ms !== undefined ? { pre_generation_ms: timing.pre_generation_ms } : {}),
      ...(timing !== undefined ? { cache: timing.cache } : {}),
    },
    ...(review?.query !== undefined ? { input: maskPII(review.query) } : {}),
    ...(review?.answer !== undefined ? { output: maskPII(review.answer) } : {}),
    ...(content?.query !== undefined ? { input: maskPII(content.query) } : {}),
    ...(content?.chunks !== undefined ? { output: maskPII({ chunks: content.chunks }) } : {}),
  };

  const root = startObservation(trace.name ?? 'rag-request', rootAttributes, {
    startTime: new Date(trace.startedAt),
    parentSpanContext: {
      traceId: trace.traceId,
      spanId: randomBytes(8).toString('hex'),
      traceFlags: TraceFlags.SAMPLED,
    },
  });
  root.otelSpan.setAttributes(common);

  for (const stage of trace.stages) {
    const child = startObservation(
      stage.name,
      {
        metadata: { tenantKey: trace.tenantKey, ...stageMetadata(stage) },
        level: levelFor(stage),
        ...(stage.reason !== undefined ? { statusMessage: stage.reason } : {}),
      },
      { startTime: new Date(stage.startedAt), parentSpanContext: root.otelSpan.spanContext() },
    );
    child.otelSpan.setAttributes(common);
    child.end(new Date(stage.endedAt));
  }
  root.end(new Date(trace.endedAt));

  await raceFlush(provider.forceFlush(), flushTimeoutMs);
}
