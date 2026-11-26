export const ENQUEUE_REVIEW_RPC = 'rag_enqueue_review_item';

export type EnqueueReviewReason = 'claim_unsupported' | 'output_guard' | 'version_conflict';

export interface EnqueueReviewItemInput {
  tenantKey: string;
  reason: EnqueueReviewReason;
  sourceChunkIds?: readonly string[];
  documentIds?: readonly string[];
  detector?: string | null;
  traceId?: string | null;
}

export interface EnqueueReviewItemDeps {
  rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  enabled?: () => boolean;
  log?: (line: string) => void;
}

export async function enqueueReviewItem(_input: EnqueueReviewItemInput, _deps: EnqueueReviewItemDeps = {}): Promise<string | null> {
  return null;
}
