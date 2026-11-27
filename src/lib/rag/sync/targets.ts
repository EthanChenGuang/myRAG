import { rpcRows, RetrievalBackendError, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import type { VectorStore, VectorSyncTarget } from './stores/types';

export const VECTOR_SYNC_TARGETS: readonly VectorSyncTarget[] = ['weaviate', 'qdrant'];

export interface VectorSyncTargetStatus {
  target: VectorSyncTarget;
  enabled: boolean;
  pending: number;
  leased: number;
  dead: number;
  oldestPendingSeconds: number | null;
}

export type VectorStoreFactories = Record<VectorSyncTarget, () => Promise<VectorStore>>;

/** Vendor clients load on first use only, so importing @/lib/rag does not pull them into every route. */
export const defaultStoreFactories: VectorStoreFactories = {
  qdrant: async () => {
    const [{ getQdrantWriteClient }, { createQdrantStore }] = await Promise.all([
      import('@/lib/rag/backend/qdrant/client'),
      import('./stores/qdrant'),
    ]);
    return createQdrantStore({ writeClient: getQdrantWriteClient() });
  },
  weaviate: async () => {
    const [{ getWeaviateWriteClient }, { createWeaviateStore }] = await Promise.all([
      import('@/lib/rag/backend/weaviate/client'),
      import('./stores/weaviate'),
    ]);
    return createWeaviateStore({ client: await getWeaviateWriteClient() });
  },
};

export function isVectorSyncTarget(value: unknown): value is VectorSyncTarget {
  return typeof value === 'string' && (VECTOR_SYNC_TARGETS as readonly string[]).includes(value);
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 0708 rag_vector_sync_status: counts per target only, never a tenant key or an error text. */
export async function readVectorSyncStatus(rpc: RpcClient): Promise<VectorSyncTargetStatus[]> {
  const response = await rpc.rpc('rag_vector_sync_status', {}).abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError('rag_vector_sync_status', response.error.code ?? null);
  const out: VectorSyncTargetStatus[] = [];
  for (const raw of rpcRows(response.data) as Array<Record<string, unknown>>) {
    if (!isVectorSyncTarget(raw.target)) continue;
    const oldest = raw.oldest_pending_seconds;
    out.push({
      target: raw.target,
      enabled: raw.enabled === true,
      pending: count(raw.pending),
      leased: count(raw.leased),
      dead: count(raw.dead),
      oldestPendingSeconds: oldest === null || oldest === undefined ? null : count(oldest),
    });
  }
  return out;
}

export async function readEnabledTargets(rpc: RpcClient): Promise<VectorSyncTarget[]> {
  return (await readVectorSyncStatus(rpc)).filter((row) => row.enabled).map((row) => row.target);
}

/**
 * One write store per enabled target. A target whose client cannot be built (URL or key unset) is left out, so its rows fail with
 * target_unavailable and stay retryable; the warning names the target and the error class only.
 */
export async function buildVectorSyncStores(
  targets: readonly VectorSyncTarget[],
  factories: VectorStoreFactories = defaultStoreFactories,
  warn: (line: string, detail: Record<string, string>) => void = console.warn,
): Promise<VectorStore[]> {
  const stores: VectorStore[] = [];
  for (const target of targets) {
    try {
      stores.push(await factories[target]());
    } catch (error) {
      warn('[Vector Sync] store unavailable', { target, error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  return stores;
}

export interface VectorSyncTargetFlag {
  target: VectorSyncTarget;
  enabled: boolean;
}

/** D-24: the enabled flag of both targets for the Config UI; a target with no row reads as disabled. */
export async function listVectorSyncTargets(rpc: RpcClient): Promise<VectorSyncTargetFlag[]> {
  const status = await readVectorSyncStatus(rpc);
  return VECTOR_SYNC_TARGETS.map((target) => ({ target, enabled: status.find((row) => row.target === target)?.enabled ?? false }));
}

export interface SetVectorSyncTargetResult {
  target: VectorSyncTarget;
  enabled: boolean;
  /** What 0703 rag_vector_sync_set_target enqueued: one tenant entity per tenant on a first enable, else 0. */
  tenantsEnqueued: number;
}

/** D-24: turns a sync target on or off through 0703 rag_vector_sync_set_target with the caller's id as the audit actor. */
export async function setVectorSyncTarget(
  rpc: RpcClient,
  target: VectorSyncTarget,
  enabled: boolean,
  actor: string,
): Promise<SetVectorSyncTargetResult> {
  if (!isVectorSyncTarget(target)) throw new RetrievalBackendError('rag_vector_sync_set_target', 'invalid_target');
  if (typeof actor !== 'string' || actor.trim() === '') throw new RetrievalBackendError('rag_vector_sync_set_target', 'actor_required');
  const response = await rpc
    .rpc('rag_vector_sync_set_target', { p_target: target, p_enabled: enabled, p_actor: actor })
    .abortSignal(new AbortController().signal);
  if (response.error) throw new RetrievalBackendError('rag_vector_sync_set_target', response.error.code ?? null);
  const raw = Array.isArray(response.data) ? response.data[0] : response.data;
  return { target, enabled, tenantsEnqueued: count(raw) };
}
