import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { VectorSyncSliceReport } from '@/lib/rag-eval/contracts.generated';
import { DRAIN_DEFAULT_BUDGET_MS, drainSlice } from './drain';
import { RECONCILE_DEFAULT_BUDGET_MS, reconcileSlice } from './reconcile';
import type { VectorStore, VectorSyncTarget } from './stores/types';
import { buildVectorSyncStores, readEnabledTargets, type VectorStoreFactories } from './targets';

export type VectorSyncMode = 'drain' | 'reconcile';

export interface RunVectorSyncSliceOptions {
  rpc: RpcClient;
  budgetMs?: number;
  /** Stores to use as given; otherwise one per enabled target (or per `targets`) is built. */
  stores?: VectorStore[];
  targets?: VectorSyncTarget[];
  factories?: VectorStoreFactories;
}

async function resolveStores(options: RunVectorSyncSliceOptions): Promise<VectorStore[]> {
  if (options.stores) return options.stores;
  const targets = options.targets ?? (await readEnabledTargets(options.rpc));
  return buildVectorSyncStores(targets, options.factories);
}

/** One slice, the unit the route, the kick and the CLI share (D-04, D-05). No request signal reaches it (Pitfall 9). */
export async function runVectorSyncSlice(mode: VectorSyncMode, options: RunVectorSyncSliceOptions): Promise<VectorSyncSliceReport> {
  const stores = await resolveStores(options);
  if (mode === 'reconcile') {
    const result = await reconcileSlice({ stores, rpc: options.rpc, budgetMs: options.budgetMs ?? RECONCILE_DEFAULT_BUDGET_MS });
    return result.slice;
  }
  return drainSlice({ stores, rpc: options.rpc, budgetMs: options.budgetMs ?? DRAIN_DEFAULT_BUDGET_MS });
}
