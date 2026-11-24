import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';
import { createIngestTrace, finishIngestTrace, type IngestTrace } from './trace';
import type { IngestResult, StageName } from './types';

const POST_PARSE: readonly StageName[] = [
  'content_hash_dedup',
  'scan_injection',
  'chunk',
  'enrich',
  'extract',
  'images',
  'embed',
  'write',
  'publish',
];

function pagesBetween(start: number, end: number): number {
  return Math.max(0, end - start + 1);
}

/** Records ledger-derived spans on the trace collector; names and rules only, no document text (D-24, D-44). */
export function buildQueueIngestTrace(job: IngestionJob, trace: IngestTrace): void {
  const { collector } = trace;
  const now = collector.now;
  const timings = job.timings ?? {};

  const detect = job.detect_counts;
  if (detect) {
    const started = now();
    collector.record({
      name: 'preflight',
      status: 'ok',
      startedAt: started,
      endedAt: started,
      rules: [`L1:${detect.L1}`, `L2:${detect.L2}`, `L3:${detect.L3}`],
    });
  }

  for (const attempt of job.attempts ?? []) {
    const started = now();
    const pages = pagesBetween(attempt.pages.start, attempt.pages.end);
    collector.record({
      name: `parse:${attempt.attempt_no}`,
      status: attempt.refused ? 'error' : 'ok',
      ...(attempt.refused ? { reason: 'failed' as const } : {}),
      startedAt: started,
      endedAt: started + attempt.ms,
      rules: [
        `tier:${attempt.tier}`,
        `pages:${pages}`,
        `est_cost:${attempt.est_cost_usd}`,
        `reason:${attempt.reason}`,
        `parser_used:${attempt.parser}`,
      ],
    });
  }

  if (typeof timings.check === 'number') {
    const started = now();
    collector.record({ name: 'check', status: 'ok', startedAt: started, endedAt: started + timings.check });
  }

  for (const stage of POST_PARSE) {
    const ms = timings[stage];
    if (typeof ms !== 'number') continue;
    const started = now();
    collector.record({ name: stage, status: 'ok', startedAt: started, endedAt: started + ms });
  }
}

export interface FinishQueueTraceInput {
  scope: TenantScope;
  job: IngestionJob;
  status: IngestionJob['status'];
  errorClass?: string | null;
  sink?: (line: string) => void;
}

function ingestResultOf(job: IngestionJob, status: IngestionJob['status'], errorClass?: string | null): IngestResult {
  if (status === 'failed') {
    return {
      status: 'failed',
      documentId: job.document_id,
      version: job.version,
      parserUsed: job.parser_used,
      chunkCount: 0,
      warnings: [],
      reason: errorClass ?? 'job_failed',
    };
  }
  if (status === 'quarantined') {
    return { status: 'quarantined', documentId: job.document_id, version: job.version, parserUsed: job.parser_used, chunkCount: 0, warnings: [] };
  }
  if (status === 'skipped_duplicate') {
    return { status: 'skipped_duplicate', documentId: job.document_id, version: job.version, parserUsed: null, chunkCount: 0, warnings: [] };
  }
  return {
    status: 'ready',
    documentId: job.document_id,
    version: job.version,
    parserUsed: job.parser_used,
    chunkCount: 0,
    warnings: [],
    ...(status === 'needs_review' && job.needs_review_reason ? { reason: job.needs_review_reason } : {}),
  };
}

/** Finishes the queued ingest trace and emits exactly one `[Ingest Alert]` line on failure. Never throws. */
export function finishQueueIngestTrace(input: FinishQueueTraceInput): void {
  const { scope, job, status, errorClass, sink } = input;
  try {
    const trace = createIngestTrace(scope);
    if (!trace) return;
    buildQueueIngestTrace(job, trace);
    const result = ingestResultOf(job, status, errorClass);
    const logSink = sink ?? ((line) => console.log(line));
    if (status === 'failed') {
      console.error(`[Ingest Alert] ${JSON.stringify({ job_id: job.id, error_class: errorClass ?? 'failed' })}`);
    }
    finishIngestTrace(trace, result, { sink: logSink });
  } catch {
    // tracing must never affect the job
  }
}