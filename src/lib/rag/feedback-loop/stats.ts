import type { FeedbackLoopStats } from '@/lib/rag-eval/contracts.generated';

export class StatsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function computeFeedbackLoopStats(_input: unknown = {}, _deps: unknown = {}): Promise<FeedbackLoopStats> {
  return { schema_version: 1, since: '', until: '', tenants: [] };
}
