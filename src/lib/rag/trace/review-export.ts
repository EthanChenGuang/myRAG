import type { ReviewReason } from '@/lib/answers/store';
import { isLangfuseUsable, readLangfuseConfig, type LangfuseConfig } from './config';
import type { CollectedTrace, ExportTraceOptions } from './langfuse';
import { maskPII } from './mask';
import { accessGroupsEnabled } from '../tenant/access';

export interface ReviewCandidateInput {
  traceId: string;
  tenantKey: string;
  reason: ReviewReason;
  query: string;
  answer: string;
  /** The cited snapshot quotes, in citation order. */
  citedQuotes: string[];
  model: string;
  /** Phase 4.3 (D-25): the cited documents' access-key arrays, as computed for the answer record; absent or null means unknown. */
  accessSets?: readonly (readonly string[])[] | null;
}

export type ReviewExportStatus = 'exported' | 'skipped' | 'failed';

export interface ReviewExportOptions {
  config?: LangfuseConfig;
  exportTrace?: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  timeoutMs?: number;
  /** Injected for tests; defaults to RAG_DOC_ACCESS_GROUPS. A failed read counts as on. */
  accessOn?: () => boolean;
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

function accessOn(options: ReviewExportOptions): boolean {
  try {
    return (options.accessOn ?? accessGroupsEnabled)();
  } catch {
    return true;
  }
}

/**
 * D-25 (T-04.3-143): with access groups on, the review copy keeps its text only when every cited document is labelled exactly `all`.
 * Unknown labels (no sets) count as restricted, so an answer with no recorded sets exports ids and counts only.
 */
export function reviewContentRestricted(accessSets: ReviewCandidateInput['accessSets']): boolean {
  if (!Array.isArray(accessSets) || accessSets.length === 0) return true;
  return accessSets.some((set) => !Array.isArray(set) || set.length !== 1 || set[0] !== 'all');
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
    const restricted = accessOn(options) && reviewContentRestricted(input.accessSets);
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
      review: restricted
        ? { model: input.model, citedCount: input.citedQuotes.length }
        : {
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
