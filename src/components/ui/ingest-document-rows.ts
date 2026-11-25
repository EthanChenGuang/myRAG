import type { IngestJobState } from '@/lib/hooks/use-ingest-job-status';

export interface IngestRow {
  id: string;
  name: string;
  status?: 'processing' | 'ready' | 'failed';
  uploadedAt?: Date;
  error?: string;
  jobId?: string;
  jobOrganizationId?: string | null;
  ingest?: IngestJobState;
}

export type UploadOutcome =
  | { kind: 'queued'; jobId: string; documentId: string | null }
  | { kind: 'poll'; documentId: string }
  | { kind: 'inline' };

const SETTLED_OK = new Set(['ready', 'skipped_duplicate', 'needs_review']);
const SETTLED_ALL = new Set(['ready', 'skipped_duplicate', 'needs_review', 'failed', 'quarantined', 'not_found', 'unavailable']);

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 202 with a job id is a queued upload; 202 without one keeps the document status poll; everything else is inline. */
export function classifyUploadResponse(status: number, body: unknown): UploadOutcome {
  if (status !== 202 || !body || typeof body !== 'object') return { kind: 'inline' };
  const record = body as Record<string, unknown>;
  const documentId = nonEmptyString(record.documentId) ?? nonEmptyString(record.id);
  const jobId = nonEmptyString(record.jobId);
  if (jobId) return { kind: 'queued', jobId, documentId };
  if (documentId) return { kind: 'poll', documentId };
  return { kind: 'inline' };
}

/** Turns the temporary upload row into a processing row that carries the job id. */
export function attachQueuedJob<T extends IngestRow>(
  rows: T[],
  rowId: string,
  job: { jobId: string; documentId: string | null; organizationId: string | null },
): T[] {
  return rows.map((row) =>
    row.id === rowId
      ? { ...row, id: job.documentId ?? row.id, status: 'processing' as const, jobId: job.jobId, jobOrganizationId: job.organizationId }
      : row,
  );
}

/** Records a job's final state on its row once; ready and needs_review rows count as present, the rest as failed. */
export function settleQueuedRow<T extends IngestRow>(rows: T[], jobId: string, state: IngestJobState): T[] {
  if (!SETTLED_ALL.has(state.status)) return rows;
  return rows.map((row) => {
    if (row.jobId !== jobId || row.ingest) return row;
    if (SETTLED_OK.has(state.status)) return { ...row, status: 'ready' as const, ingest: state };
    return { ...row, status: 'failed' as const, error: state.reason ?? state.status, ingest: state };
  });
}

/** The safety timeout fails processing rows, except queued uploads that are still being followed through their job. */
export function failStalledProcessingRows<T extends IngestRow>(rows: T[]): T[] {
  return rows.map((row) => (row.status === 'processing' && !row.jobId ? { ...row, status: 'failed' as const } : row));
}

function isKeptJobRow(row: IngestRow): boolean {
  return Boolean(row.jobId && row.ingest && row.ingest.status !== 'ready' && row.ingest.status !== 'skipped_duplicate');
}

const uploadTimestamp = (row: IngestRow) => row.uploadedAt?.getTime() ?? 0;

/**
 * Merges a fresh document list into the rows on screen. Processing rows stay until they complete; a row that
 * carries a job id is never replaced by its same-named document while the job runs, and needs_review or failed
 * job rows stay visible. Settled ready rows are replaced by the normal document row.
 */
export function mergeRefreshedDocuments<T extends IngestRow>(previous: T[], fetched: T[]): T[] {
  const pinned = previous.filter((row) => row.status === 'processing' || isKeptJobRow(row));
  const kept = pinned.map((row) => {
    if (row.jobId) return row;
    return fetched.find((candidate) => candidate.name === row.name) ?? row;
  });
  const genuinelyNew = fetched.filter((candidate) => !pinned.some((row) => row.name === candidate.name));
  return [...kept, ...genuinelyNew].sort((a, b) => uploadTimestamp(b) - uploadTimestamp(a));
}
