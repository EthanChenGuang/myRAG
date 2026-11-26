import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { ReconcileReport, VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import type { VectorSyncLogSink } from './log';
import type { VectorStore } from './stores/types';
import type { VectorSyncTraceOptions } from './trace';

export const RECONCILE_PRUNE_DAYS = 0;

export function bucketOf(_id: string): number {
  return 0;
}

export function idHash64(_id: string): bigint {
  return 0n;
}

export interface ReconcileSliceOptions {
  stores: VectorStore[];
  rpc: RpcClient;
  budgetMs?: number;
  now?: () => number;
  sink?: VectorSyncLogSink;
  trace?: VectorSyncTraceOptions | false;
}

export interface ReconcileSliceResult {
  slice: VectorSyncSliceReport;
  reports: ReconcileReport[];
  pruned: number;
}

export async function reconcileSlice(_options: ReconcileSliceOptions): Promise<ReconcileSliceResult> {
  return {
    slice: { mode: 'reconcile', claimed: 0, upserted: 0, deleted: 0, failed: 0, dead: 0, lag_seconds: 0, elapsed_ms: 0, budget_ms: 0, more_pending: false },
    reports: [],
    pruned: 0,
  };
}
