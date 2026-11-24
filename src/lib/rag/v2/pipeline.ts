import { logger } from '@/lib/logger';
import { RetrievalBackendError } from '../backend/supabase-rpc';
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { getEmbeddingProfileById } from '../embeddings/active-profile';
import {
  classifyProfileFailure,
  embedQueries,
  embedQueriesForEvalProfile,
  embedQuery,
  embedQueryForEvalProfile,
  type QueryEmbedding,
} from '../embeddings/query-embedding';
import { failure, requireValue, runStage, stageSpec, StageError } from '../pipeline';
import { assertTenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { Candidate, Profile, RetrievalResult, RunRetrievalInput } from '../types';
import { evalRetrievalOverrides } from './overrides';
import { effectiveRetrievalParams } from './retrieval-params';
import { runContextStages } from './stages/context';
import { runQueryStages } from './stages/query';
import { runRankStages } from './stages/rank';
import { runSearchStages } from './stages/search';
import { buildV2Result } from './result';

export const V2_PROFILES = ['chat', 'embed', 'eval'] as const;

function evalEmbeddingProfileId(input: RunRetrievalInput): string | undefined {
  return input.profile === 'eval' ? input.options?.embeddingProfile : undefined;
}

async function embedForRetrieval(input: RunRetrievalInput, texts: string[], signal: AbortSignal): Promise<QueryEmbedding[]> {
  const profileId = evalEmbeddingProfileId(input);
  if (texts.length === 1) {
    const [text] = texts;
    if (profileId) return [await embedQueryForEvalProfile(text!, signal, await getEmbeddingProfileById(profileId))];
    return [await embedQuery(text!, signal)];
  }
  if (profileId) return embedQueriesForEvalProfile(texts, signal, await getEmbeddingProfileById(profileId));
  return embedQueries(texts, signal);
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

  let queryContext = null;
  let embedding: QueryEmbedding;
  let assembly = null;
  let candidates: RetrievalResult['candidates'] = [];
  let refusal = null;
  let queryLanguage: RetrievalResult['queryLanguage'] = null;
  let preRefusalCandidates: Candidate[] | undefined;

  try {
    const query = await runQueryStages({
      input,
      scope,
      config,
      profile,
      signal,
      collector,
      stageOverrides: input.stageOverrides,
    });
    queryContext = query.queryContext;
    queryLanguage = query.queryLanguage;

    const variantEmbeddings = requireValue(
      await runStage(
        spec('embed', 'throw'),
        signal,
        (stageSignal) =>
          embedForRetrieval(
            input,
            query.variants.map((variant) => variant.text),
            stageSignal,
          ),
        collector,
        { detail: (value) => value[0]?.profile?.id },
      ),
      'embed',
    );
    embedding = variantEmbeddings[0]!;

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
      variants: query.variants,
      variantEmbeddings,
      filters: query.filters,
    });

    const rank = await runRankStages({
      input,
      config,
      profile,
      embedding,
      queryLanguage: query.queryLanguage,
      fusedHits: search.fusedHits,
      referenced: query.referenced,
      signal,
      collector,
      stageOverrides: input.stageOverrides,
      variants: query.variants,
      dedupeCounts: search.dedupeCounts,
    });
    refusal = rank.decision;

    const context = await runContextStages({
      input,
      config,
      profile,
      params,
      fusedHits: rank.survivors,
      referenced: query.referenced,
      signal,
      collector,
      stageOverrides: input.stageOverrides,
      rerank: rank.rerank,
    });
    assembly = context.assembly;
    candidates = context.candidates;
    if (profile === 'eval' && rank.decision.decision === 'refuse') {
      preRefusalCandidates = rank.preRefusalHits.map((row, index) => ({
        chunk_id: row.hit.chunkId,
        document_id: row.hit.documentId,
        content: row.hit.content,
        similarity: row.hit.similarity ?? 0,
        metadata: row.hit.metadata,
        temporal_score: 0,
        financial_score: 0,
        final_score: row.score,
        fused_score: row.score,
        match_reason: `fused: ${row.score.toFixed(4)}`,
        parent_id: row.hit.parentId,
        legs: Object.fromEntries(Object.entries(row.ranks).map(([key, value]) => [key, value])),
        language: row.hit.language,
        ...(rank.rerank.scoreByChunk.has(row.hit.chunkId)
          ? { rerank_score: rank.rerank.scoreByChunk.get(row.hit.chunkId) }
          : {}),
      }));
    }
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
    refusal,
    queryLanguage,
    preRefusalCandidates,
  });
}

export function isV2RetrievalProfile(profile: Profile): boolean {
  return (V2_PROFILES as readonly string[]).includes(profile);
}