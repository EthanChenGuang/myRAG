import type { RpcClient } from '../backend/supabase-rpc';
import type { EmbeddingProfile } from '../embeddings/active-profile';

export interface EmbedQueriesOptions {
  db: RpcClient;
  bundleDir: string;
  profile: EmbeddingProfile;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface EmbedQueriesReport {
  profileId: string;
  batches: number;
  tenants: { tenantKey: string; rows: number }[];
}

export async function embedBundleQueries(_options: EmbedQueriesOptions): Promise<EmbedQueriesReport> {
  throw new Error('embed-queries is not implemented yet');
}
