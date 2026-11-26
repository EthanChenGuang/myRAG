import type { DeploymentMode } from './pglite-supabase.mts';

/** One candidate pair: ids and numbers only, never chunk text. */
export interface DupPair {
  tenant: string;
  embedding_profile_id: string;
  chunk_a: string;
  chunk_b: string;
  hamming: number | null;
  cosine: number | null;
  same_template: boolean;
}

export interface RunDupPairsOptions {
  corpusDir: string;
  deploymentMode: DeploymentMode;
}

export async function runDupPairs(_options: RunDupPairsOptions): Promise<DupPair[]> {
  return [];
}
