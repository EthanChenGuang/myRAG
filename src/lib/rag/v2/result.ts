import { getRetrievalBackend } from '../backend/registry';
import type { RagConfig } from '../config';
import { getActiveChunkingProfiles } from '../chunking/active';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import { LEXICAL_VERSION } from '../lexical/chunk-text';
import { assembleDisabledStatus, degradedReason, deriveStatus, failure } from '../pipeline';
import { evalRetrievalOverrides } from './overrides';
import { loadThresholds } from '../refusal/thresholds';
import { RERANK_TEXT_VERSION } from '../rerank/types';
import type { TraceCollector } from '../trace/collector';
import type { Candidate, Profile, RetrievalResult, RunRetrievalInput } from '../types';
import type { TemporalQueryContext } from '../query/temporal-query-detector';
import { computeRetrievalConfigHash } from './config-hash';
import { effectiveRetrievalParams } from './retrieval-params';
import type { AssembleOutput } from '../context/assemble';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';

export interface BuildV2ResultInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  params: RetrievalParams;
  embedding: QueryEmbedding;
  assembly: AssembleOutput<Candidate> | null;
  candidates: Candidate[];
  collector: TraceCollector;
  queryContext: TemporalQueryContext | null;
}

function survivorCount(assembly: AssembleOutput<Candidate>): number {
  return assembly.usedDocuments.length + assembly.relevantChunks.length;
}

export async function buildV2Result(ctx: BuildV2ResultInput): Promise<RetrievalResult> {
  const { input, config, profile, params, embedding, assembly, candidates, collector, queryContext } = ctx;
  const records = collector.stages();
  const survivors = assembly ? survivorCount(assembly) : candidates.length;
  const status = assembleDisabledStatus(records, deriveStatus(records, survivors), assembly ? 1 : 0);
  const reason =
    status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? candidates.length === 0
          ? 'no_candidates'
          : 'no_relevant_context'
        : degradedReason(records);

  const { configHash: thresholdsConfigHash } = loadThresholds();
  const chunking = await getActiveChunkingProfiles();
  const profileId = embedding.profile?.id ?? LEGACY_PROFILE.id;
  const retrievalConfigHash = computeRetrievalConfigHash({
    backendId: getRetrievalBackend().id,
    embeddingProfileId: profileId,
    lexicalVersion: LEXICAL_VERSION,
    rerankTextVersion: RERANK_TEXT_VERSION,
    params: effectiveRetrievalParams(profile, config, evalRetrievalOverrides(profile, input.stageOverrides?.retrievalOverrides)),
    reranker: { id: config.v2.reranker, model: config.v2.reranker === 'none' ? 'none' : config.v2.reranker },
    thresholdsConfigHash,
    activeChunkingProfiles: chunking,
    switches: {
      lexicalSearch: config.v2.lexicalSearch,
      refusalThreshold: config.v2.refusalThreshold,
      edgeOrder: config.v2.edgeOrder,
      compression: config.v2.compression,
      tokenBudget: config.v2.tokenBudget,
      parentChild: config.v2.parentChild,
      iterativeScan: config.v2.iterativeScan,
      exactScanCutoff: config.v2.exactScanCutoff,
      lexicalTranslation: config.v2.lexicalTranslation,
      exactIdLookup: config.exactIdLookup,
      rerankTierChat: config.v2.rerankTier.chat,
      rerankTierVoice: config.v2.rerankTier.voice,
    },
  });

  const base = failure(collector, status, reason, queryContext);
  if (!assembly) {
    return { ...base, candidates, retrievalConfigHash, refusal: null };
  }

  return {
    ...base,
    candidates,
    context: assembly.context,
    usedDocuments: assembly.usedDocuments,
    sourceImages: assembly.sourceImages,
    links: assembly.links,
    relevantChunks: assembly.relevantChunks,
    kept: assembly.kept,
    queryTerms: assembly.queryTerms,
    refusalCandidate: assembly.refusalCandidate,
    retrievalConfigHash,
    refusal: null,
  };
}