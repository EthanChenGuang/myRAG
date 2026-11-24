import type { IngestJobState } from '@/lib/hooks/use-ingest-job-status';

export type IngestStatusTone = 'pending' | 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface IngestStatusDescription {
  label: string;
  tone: IngestStatusTone;
}

export function describeIngestStatus(_state: IngestJobState, _language: string): IngestStatusDescription {
  return { label: '', tone: 'neutral' };
}
