import { randomBytes } from 'node:crypto';
import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from '@/lib/rag/trace/config';
import type { CollectedTrace, ExportTraceOptions } from '@/lib/rag/trace/langfuse';
import { isSampled } from '@/lib/rag/trace/sample';
import { buildVectorSyncLogPayload } from './log';

export interface VectorSyncTraceOptions {
  config?: LangfuseConfig;
  exportTrace?: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  startedAt?: number;
  flushTimeoutMs?: number;
}

/** The trace is not about one tenant: this fixed label fills the exporter's tenant fields. */
const SYSTEM_LABEL = 'vector_sync';

export function buildVectorSyncTrace(report: VectorSyncSliceReport, traceId: string, startedAt: number): CollectedTrace {
  const payload = buildVectorSyncLogPayload(report);
  const endedAt = startedAt + payload.elapsedMs;
  return {
    name: 'vector_sync',
    traceId,
    tenantKey: SYSTEM_LABEL,
    profile: SYSTEM_LABEL,
    status: report.failed > 0 ? 'degraded' : 'ok',
    reason: payload.mode,
    tags: ['vector-sync', `mode:${payload.mode}`],
    startedAt,
    endedAt,
    stages: [
      {
        name: 'slice',
        status: 'ok',
        startedAt,
        endedAt,
        latency_ms: payload.elapsedMs,
        candidates_in: payload.claimed,
        candidates_out: payload.upserted,
        rules: [],
        attributes: {
          mode: payload.mode,
          claimed: payload.claimed,
          upserted: payload.upserted,
          deleted: payload.deleted,
          failed: payload.failed,
          dead: payload.dead,
          lag_seconds: payload.lagSeconds,
          elapsed_ms: payload.elapsedMs,
          more_pending: report.more_pending === true,
        },
      },
    ],
  };
}

/**
 * D-25: one `vector_sync` trace per slice when Langfuse is enabled, through the Phase 2 exporter (same sampling, async flush).
 * Fire and forget: the slice never waits on it and an export failure is swallowed (the log line already went out).
 */
export function traceVectorSync(report: VectorSyncSliceReport, options: VectorSyncTraceOptions = {}): void {
  try {
    const config = options.config ?? readLangfuseConfig();
    const traceId = randomBytes(16).toString('hex');
    if (!isLangfuseUsable(config) || !isSampled(traceId, config.sampleRate, 'trace')) return;
    const trace = buildVectorSyncTrace(report, traceId, options.startedAt ?? Date.now() - report.elapsed_ms);
    const exporter = options.exportTrace ?? (async (t, o) => (await import('@/lib/rag/trace/langfuse')).exportTrace(t, o));
    void Promise.resolve()
      .then(() =>
        exporter(trace, { config, ...(options.flushTimeoutMs !== undefined ? { flushTimeoutMs: options.flushTimeoutMs } : {}) }),
      )
      .catch(() => undefined);
  } catch {
    // tracing must never affect the slice
  }
}
