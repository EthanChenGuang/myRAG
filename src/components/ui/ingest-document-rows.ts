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

export function classifyUploadResponse(_status: number, _body: unknown): UploadOutcome {
  return { kind: 'inline' };
}

export function attachQueuedJob<T extends IngestRow>(
  rows: T[],
  _rowId: string,
  _job: { jobId: string; documentId: string | null; organizationId: string | null },
): T[] {
  return rows;
}

export function settleQueuedRow<T extends IngestRow>(rows: T[], _jobId: string, _state: IngestJobState): T[] {
  return rows;
}

export function failStalledProcessingRows<T extends IngestRow>(rows: T[]): T[] {
  return rows;
}

export function mergeRefreshedDocuments<T extends IngestRow>(_previous: T[], fetched: T[]): T[] {
  return fetched;
}
