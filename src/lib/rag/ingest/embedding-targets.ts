import type { EmbeddingProfile } from '../embeddings/active-profile';

export type EmbeddingTargetRole = 'active' | 'backfilling' | 'previous';

export interface EmbeddingTarget {
  profile: EmbeddingProfile;
  role: EmbeddingTargetRole;
  runId: string | null;
}

export interface BackfillRunLookup {
  findBackfillRuns(): Promise<Array<{ profileId: string; runId: string; status: string }>>;
}

export async function resolveEmbeddingTargets(_writer: BackfillRunLookup): Promise<EmbeddingTarget[]> {
  return [];
}
