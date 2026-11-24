import { logger } from '@/lib/logger';
import { RetrievalBackendError } from '../backend/supabase-rpc';
import { loadRagConfig } from '../config';
import { defaultQueryContext } from '../query/temporal-query-detector';
import { getRagDeps } from '../deps';
import { getEmbeddingProfileById } from '../embeddings/active-profile';
import {
  classifyProfileFailure,
  embedQuery,
  embedQueryForEvalProfile,
  type QueryEmbedding,
} from '../embeddings/query-embedding';
import { failure, requireValue, runStage, stageSpec, StageError } from '../pipeline';
import { assertTenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { Profile, RetrievalResult, RunRetrievalInput } from '../types';
import { evalRetrievalOverrides } from './overrides';
import { effectiveRetrievalParams } from './retrieval-params';
import { runContextStages } from './stages/context';
import { runSearchStages } from './stages/search';
import { buildV2Result } from './result';

export const V2_PROFILES = ['chat', 'embed', 'eval'] as const;

function evalEmbeddingProfileId(input: RunRetrievalInput): string | undefined {
  return input.profile === 'eval' ? input.options?.embeddingProfile : undefined;
}

async function embedForRetrieval(input: RunRetrievalInput, signal: AbortSignal): Promise<QueryEmbedding> {
  const profileId = evalEmbeddingProfileId(input);
  if (profileId) return embedQueryForEvalProfile(input.query, signal, await getEmbeddingProfileById(profileId));
  return embedQuery(input.query, signal);
}

const PROFILE_FAILURE_REASONS = {
  mismatch: 'embedding_profile_mismatch',
  unavailable: 'embedding_profile_unavailable',
} as const;

function profileFailureReason(original: unknown): string | null {
  const kind = classifyProfileFailure(original);
  return kind ? PROFILE_FAILURE_REASONS[kind] : null;
}

export async function runV2Pipeline(input: RunRetrievalInput, collector: TraceCollector): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const scope = input.scope;

  if (scope === null) {
    return failure(collector, 'empty', 'no_tenant', null);
  }

  const { signal, profile } = input;
  const config = loadRagConfig(deps.ragEnv());
  const spec = (name: Parameters<typeof stageSpec>[2], onFail: Parameters<typeof stageSpec>[3]) =>
    stageSpec(config, profile, name, onFail, input.stageOverrides);
  const params = effectiveRetrievalParams(profile, config, evalRetrievalOverrides(profile, input.stageOverrides?.retrievalOverrides));
  const queryContext = defaultQueryContext();
  let embedding: QueryEmbedding;
  let assembly = null;
  let candidates: RetrievalResult['candidates'] = [];

  try {
    embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => embedForRetrieval(input, stageSignal), collector, {
        detail: (value) => value.profile?.id,
      }),
      'embed',
    );

    const search = await runSearchStages({
      input,
      scope,
      config,
      profile,
      params,
      embedding,
      signal,
      collector,
      stageOverrides: input.stageOverrides,
    });

    const context = await runContextStages({
      input,
      config,
      profile,
      params,
      fusedHits: search.fusedHits,
      referenced: null,
      signal,
      collector,
      stageOverrides: input.stageOverrides,
    });
    assembly = context.assembly;
    candidates = context.candidates;
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', queryContext);
      const profileReason = profileFailureReason(error.original);
      if (profileReason) return failure(collector, 'error', profileReason, queryContext);
      if (error.original instanceof RetrievalBackendError) {
        logger.error('RAG Pipeline', 'Backend error', { rpc: error.original.rpc, code: error.original.code });
        return failure(collector, 'error', 'backend_error', queryContext);
      }
      logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason });
      return failure(collector, 'error', `${error.stage}_${error.reason}`, queryContext);
    }
    if (signal.aborted) return failure(collector, 'error', 'aborted', queryContext);
    throw error;
  }

  return buildV2Result({
    input,
    config,
    profile,
    params,
    embedding: embedding!,
    assembly,
    candidates,
    collector,
    queryContext,
  });
}

export function isV2RetrievalProfile(profile: Profile): boolean {
  return (V2_PROFILES as readonly string[]).includes(profile);
}