import type { IngestionJob } from '@/lib/rag-eval/contracts.generated';
import type { PostPublishEvent } from '../post-publish';

export async function enqueueTranslateJob(_tenantKey: string, _documentId: string, _language: string, _options: { signal: AbortSignal }): Promise<IngestionJob> {
  throw new Error('not implemented');
}

export async function enqueueTranslateJobs(_event: PostPublishEvent, _signal: AbortSignal): Promise<IngestionJob[]> {
  return [];
}
