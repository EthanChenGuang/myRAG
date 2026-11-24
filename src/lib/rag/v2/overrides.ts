import type { RetrievalOverrides as ApiRetrievalOverrides } from '@/lib/rag-eval/contracts.generated';
import type { Profile, StageOverrides } from '../types';

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