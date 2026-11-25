import type { ReviewReason } from '@/lib/answers/store';
import type { LangfuseConfig } from './config';
import type { CollectedTrace, ExportTraceOptions } from './langfuse';

export interface ReviewCandidateInput {
  traceId: string;
  tenantKey: string;
  reason: ReviewReason;
  query: string;
  answer: string;
  citedQuotes: string[];
  model: string;
}

export type ReviewExportStatus = 'exported' | 'skipped' | 'failed';

export interface ReviewExportOptions {
  config?: LangfuseConfig;
  exportTrace?: (trace: CollectedTrace, options: ExportTraceOptions) => Promise<void>;
  timeoutMs?: number;
}

export async function exportReviewCandidate(_input: ReviewCandidateInput, _options: ReviewExportOptions = {}): Promise<ReviewExportStatus> {
  return 'skipped';
}
