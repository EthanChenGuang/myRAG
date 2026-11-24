import rawParams from '../../../../eval/config/retrieval-params.json';
import {
  RetrievalParamsSchema,
  type RetrievalOverrides,
  type RetrievalParams,
} from '@/lib/rag-eval/contracts.generated';
import type { RagConfig, RetrievalParamsOverride } from '../config';
import type { Profile } from '../types';

const loggedProblems = new Set<string>();

function problem(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[RAG Config] ${message}`, data);
}

const COMMITTED: RetrievalParams = RetrievalParamsSchema.parse(rawParams);

function guardCap(
  next: number | undefined,
  previous: number,
): number {
  if (next === undefined) return previous;
  if (next < 50 || next > 100) {
    problem(`params-cap:${next}`, 'rerank_input_cap must be 50..100, entry ignored', { cap: next });
    return previous;
  }
  return next;
}

function applyEmergencyOverride(
  current: RetrievalParams,
  override: RetrievalParamsOverride,
): RetrievalParams {
  let next = current;
  if (override.candidate_pool_size !== undefined) {
    next = { ...next, candidate_pool_size: override.candidate_pool_size };
  }
  if (override.final_top_k !== undefined) {
    next = { ...next, final_top_k: override.final_top_k };
  }
  if (override.rrf_k !== undefined) {
    next = { ...next, rrf_k: override.rrf_k };
  }
  if (override.rerank_input_cap !== undefined) {
    next = {
      ...next,
      rerank_input_cap: guardCap(override.rerank_input_cap, next.rerank_input_cap),
    };
  }
  return next;
}

function applyEvalOverrides(
  current: RetrievalParams,
  overrides: RetrievalOverrides,
): RetrievalParams {
  let next = current;
  if (overrides.candidate_pool_size !== null && overrides.candidate_pool_size !== undefined) {
    next = { ...next, candidate_pool_size: overrides.candidate_pool_size };
  }
  if (overrides.final_top_k !== null && overrides.final_top_k !== undefined) {
    next = { ...next, final_top_k: overrides.final_top_k };
  }
  if (overrides.rrf_k !== null && overrides.rrf_k !== undefined) {
    next = { ...next, rrf_k: overrides.rrf_k };
  }
  if (overrides.rerank_input_cap !== null && overrides.rerank_input_cap !== undefined) {
    next = {
      ...next,
      rerank_input_cap: guardCap(overrides.rerank_input_cap, next.rerank_input_cap),
    };
  }
  if (overrides.leg_weights) {
    next = {
      ...next,
      leg_weights: {
        dense: overrides.leg_weights.dense,
        lexical: overrides.leg_weights.lexical,
        exact_id: overrides.leg_weights.exact_id,
      },
    };
  }
  return next;
}

/** Committed retrieval-params.json, then emergency env override, then eval-only request overrides. */
export function effectiveRetrievalParams(
  profile: Profile,
  config: RagConfig,
  overrides?: RetrievalOverrides | null,
): RetrievalParams {
  let params = COMMITTED;
  params = applyEmergencyOverride(params, config.v2.paramsOverride);
  if (profile === 'eval' && overrides) {
    params = applyEvalOverrides(params, overrides);
  }
  const parsed = RetrievalParamsSchema.safeParse(params);
  if (!parsed.success) {
    return params;
  }
  return {
    ...parsed.data,
    rerank_input_cap: guardCap(parsed.data.rerank_input_cap, COMMITTED.rerank_input_cap),
  };
}