import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import type { VectorStore, VectorSyncTarget } from './stores/types';

export type VectorSyncMode = 'drain' | 'reconcile';

export interface RunVectorSyncSliceOptions {
  rpc: RpcClient;
  budgetMs?: number;
  stores?: VectorStore[];
  targets?: VectorSyncTarget[];
}

export async function runVectorSyncSlice(_mode: VectorSyncMode, _options: RunVectorSyncSliceOptions): Promise<VectorSyncSliceReport> {
  throw new Error('not implemented');
}
