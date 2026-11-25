import type { ReviewReason } from '@/lib/answers/store';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from './config';
import type { CollectedTrace, ExportTraceOptions } from './langfuse';
import { maskPII } from './mask';

export interface ReviewCandidateInput {
  traceId: string;
  tenantKey: string;
  reason: ReviewReason;
  query: string;
  answer: string;
  /** The cited snapshot quotes, in citation order. */
  citedQuotes: string[];
  model: string;
}

export type ReviewExportStatus = 'exported' | 'skipped' | 'failed';

export interface ReviewExportOptions {
  config?: LangfuseConfig;
  exportTrace?: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
const OTEL_TRACE_ID = /^[0-9a-f]{32}$/;
const BASE_TAGS = ['rag-pipeline', 'profile:chat'];

async function boxed(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('review export timed out')), timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * D-19 and research P-12: a separate masked observation on the answer's trace, tagged review_candidate (added by exportTrace for
 * review content) and review:<reason>. It does not depend on LANGFUSE_SAMPLE_RATE or LANGFUSE_REVIEW_SAMPLE_RATE. Never throws.
 */
export async function exportReviewCandidate(input: ReviewCandidateInput, options: ReviewExportOptions = {}): Promise<ReviewExportStatus> {
  try {
    const config = options.config ?? readLangfuseConfig();
    if (!isLangfuseUsable(config) || !OTEL_TRACE_ID.test(input.traceId)) return 'skipped';
    const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const now = Date.now();
    const trace: CollectedTrace = {
      traceId: input.traceId,
      tenantKey: input.tenantKey,
      profile: 'chat',
      status: 'review',
      reason: input.reason,
      tags: [...BASE_TAGS, `tenant:${input.tenantKey}`, `review:${input.reason}`],
      startedAt: now,
      endedAt: now,
      stages: [],
      review: {
        query: maskPII(input.query),
        answer: maskPII(input.answer),
        context: maskPII(input.citedQuotes.join('\n\n')),
        model: input.model,
      },
    };
    const exportTrace = options.exportTrace ?? (await import('./langfuse')).exportTrace;
    await boxed(exportTrace(trace, { config, flushTimeoutMs: timeoutMs }), timeoutMs + 500);
    return 'exported';
  } catch {
    return 'failed';
  }
}
