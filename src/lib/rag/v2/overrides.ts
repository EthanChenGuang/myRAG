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
          ...(overrides.legWeights.domain != null ? { domain: overrides.legWeights.domain } : {}),
        }
      : null,
  };
  return mapped;
}
/** The eval-only Phase 4.2 tuning blocks for effectiveTuningParams; every other profile reads the defaults. */
export function evalTuningOverrides(profile: Profile, overrides?: StageOverrides['retrievalOverrides']): TuningOverrides | undefined {
  if (profile !== 'eval' || !overrides) return undefined;
  const out: TuningOverrides = {
    ...(overrides.tableLookup ? { table_lookup: { ...overrides.tableLookup } } : {}),
    ...(overrides.diversity ? { diversity: { ...overrides.diversity } } : {}),
    ...(overrides.dupCluster ? { dup_cluster: { ...overrides.dupCluster } } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
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

/**
 * The server-side chunking override of a request: the eval override, else the candidate chunking profiles of a LANG-11 rollout the
 * tenant is on (never for eval, whose explicit overrides win). Never read from a request body.
 */
export function requestChunkingOverride(
  profile: Profile,
  overrides?: StageOverrides['retrievalOverrides'],
  rolloutOverride?: Record<string, string>,
): Record<string, string> | undefined {
  if (profile === 'eval') return evalChunkingOverride(profile, overrides);
  return rolloutOverride && Object.keys(rolloutOverride).length > 0 ? rolloutOverride : undefined;
}

/** The chunking profiles a run actually searched, for the retrieval config hash: active pointers with the request override on top. */
export function hashedChunkingProfiles(
  profile: Profile,
  active: Record<string, string> | null,
  overrides?: StageOverrides['retrievalOverrides'],
  rolloutOverride?: Record<string, string>,
): Record<string, string> | null {
  const override = requestChunkingOverride(profile, overrides, rolloutOverride);
  if (!override) return active;
  return { ...(active ?? {}), ...override };
}

/** The eval route's mapping of the API RetrievalOverrides to the internal StageOverrides shape. */
export function toStageRetrievalOverrides(
  input: ApiRetrievalOverrides | null | undefined,
): StageOverrides['retrievalOverrides'] | undefined {
  if (!input) return undefined;
  const out: NonNullable<StageOverrides['retrievalOverrides']> = {};
  if (input.candidate_pool_size != null) out.candidatePoolSize = input.candidate_pool_size;
  if (input.rerank_input_cap != null) out.rerankInputCap = input.rerank_input_cap;
  if (input.final_top_k != null) out.finalTopK = input.final_top_k;
  if (input.rrf_k != null) out.rrfK = input.rrf_k;
  if (input.leg_weights != null) {
    out.legWeights = {
      dense: input.leg_weights.dense,
      lexical: input.leg_weights.lexical,
      exactId: input.leg_weights.exact_id,
      ...(input.leg_weights.domain != null ? { domain: input.leg_weights.domain } : {}),
    };
  }
  if (input.rerank_model != null) out.rerankModel = input.rerank_model;
  if (input.chunking_profile_by_doc_type && Object.keys(input.chunking_profile_by_doc_type).length > 0) {
    out.chunkingProfileByDocType = { ...input.chunking_profile_by_doc_type };
  }
  if (input.table_lookup != null) out.tableLookup = { ...input.table_lookup };
  if (input.diversity != null) out.diversity = { ...input.diversity };
  if (input.dup_cluster != null) out.dupCluster = { ...input.dup_cluster };
  if (input.backend != null) out.backend = input.backend;
  return Object.keys(out).length > 0 ? out : undefined;
}
