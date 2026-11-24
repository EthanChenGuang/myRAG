import type { QueueConfig } from './queue-config';
import type { IngestInput, IngestResult } from './types';

export interface EnqueueResult {
  jobId: string | null;
  documentId: string | null;
  status: 'queued' | 'skipped_duplicate' | 'failed';
  reason?: string;
}

export interface SubmitIngestDeps {
  queueConfig?: () => QueueConfig;
}

export async function enqueueIngest(_input: IngestInput): Promise<EnqueueResult> {
  throw new Error('not implemented');
}

export async function submitIngest(_input: IngestInput, _deps: SubmitIngestDeps = {}): Promise<IngestResult | EnqueueResult> {
  throw new Error('not implemented');
}
