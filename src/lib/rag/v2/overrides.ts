import type { RetrievalOverrides as ApiRetrievalOverrides } from '@/lib/rag-eval/contracts.generated';
import type { Profile, StageOverrides } from '../types';
import type { TuningOverrides } from './tuning-params';

export function evalRetrievalOverrides(
  profile: Profile,
  overrides?: StageOverrides['retrievalOverrides'],
): ApiRetrievalOverrides | undefined {
  if (profile !== 'eval' || !overrides) return undefined;
  const mapped: ApiRetrievalOverrides = {
    candidate_pool_size: overrides.candidatePoolSize ?? null,
    final_top_k: overrides.finalTopK ?? null,
    rrf_k: overrides.rrfK ?? null,
    rerank_input_cap: overrides.rerankInputCap ?? null,
    rerank_model: overrides.rerankModel ?? null,
    leg_weights: overrides.legWeights
      ? {
          dense: overrides.legWeights.dense ?? 1,
          lexical: overrides.legWeights.lexical ?? 1,
          exact_id: overrides.legWeights.exactId ?? 1,
        }
      : null,
  };
  return mapped;
}
/** The eval-only Phase 4.2 tuning blocks for effectiveTuningParams; every other profile reads the defaults. */
export function evalTuningOverrides(profile: Profile, overrides?: StageOverrides['retrievalOverrides']): TuningOverrides | undefined {
  if (profile !== 'eval' || !overrides?.tableLookup) return undefined;
  return { table_lookup: { ...overrides.tableLookup } };
}

/** The eval-only chunking override as the backend takes it; every other profile searches the active pointers. */
export function evalChunkingOverride(
  profile: Profile,
  overrides?: StageOverrides['retrievalOverrides'],
): Record<string, string> | undefined {
  if (profile !== 'eval') return undefined;
  const map = overrides?.chunkingProfileByDocType;
  return map && Object.keys(map).length > 0 ? map : undefined;
}

/** The chunking profiles a run actually searched, for the retrieval config hash: active pointers with the eval override on top. */
export function hashedChunkingProfiles(
  profile: Profile,
  active: Record<string, string> | null,
  overrides?: StageOverrides['retrievalOverrides'],
): Record<string, string> | null {
  const override = evalChunkingOverride(profile, overrides);
  if (!override) return active;
  return { ...(active ?? {}), ...override };
}
