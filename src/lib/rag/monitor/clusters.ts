import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueryEmbedding } from '../embeddings/query-embedding';

export interface ClusterSamplingConfig {
  max_queries: number;
  min_queries: number;
}

export type ClusterEmbedder = (texts: string[], signal: AbortSignal) => Promise<QueryEmbedding[]>;

export interface RefreshClustersOptions {
  tenantKey: string;
  now?: Date;
  embed?: ClusterEmbedder;
  config?: ClusterSamplingConfig;
  signal?: AbortSignal;
}

export type RefreshClustersResult =
  | { written: false; reason: 'too_few_queries'; queryCount: number }
  | { written: true; refit: boolean; setId: string; k: number; clusters: number; queryCount: number; embedded: number; assigned: number; novel: number; dropped: number };

export function loadClusterSamplingConfig(_raw?: unknown): ClusterSamplingConfig {
  return { max_queries: 0, min_queries: 0 };
}

export async function refreshClusters(_admin: SupabaseClient, _options: RefreshClustersOptions): Promise<RefreshClustersResult> {
  return { written: false, reason: 'too_few_queries', queryCount: -1 };
}
