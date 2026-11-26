import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantScope } from '../tenant/scope';

export interface ClusterReport {
  hashed: number;
  clustered: number;
  clusters: number;
}

export interface ClusterOptions {
  db?: RpcClient | null;
  signal?: AbortSignal;
  threshold?: number;
  maxHamming?: number;
  rehash?: boolean;
}

export async function clusterChunks(_scope: TenantScope, _chunkIds: string[], _options: ClusterOptions = {}): Promise<ClusterReport> {
  return { hashed: 0, clustered: 0, clusters: 0 };
}
