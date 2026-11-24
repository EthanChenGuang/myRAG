import { getRetrievalBackend } from '../backend/registry';
import type { RagConfig } from '../config';
import { getActiveChunkingProfiles } from '../chunking/active';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import { LEXICAL_VERSION } from '../lexical/chunk-text';
import { assembleDisabledStatus, degradedReason, deriveStatus, failure } from '../pipeline';
import { evalRetrievalOverrides } from './overrides';
import { loadThresholds } from '../refusal/thresholds';
import type { RefusalRecord } from '../refusal/types';
import { describeReranker } from '../rerank/select';
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
  refusal: RefusalRecord | null;
  queryLanguage?: string | null;
  preRefusalCandidates?: Candidate[];
}

function survivorCount(assembly: AssembleOutput<Candidate>): number {
  return assembly.usedDocuments.length + assembly.relevantChunks.length;
}

function refusedReason(record: RefusalRecord): string {
  if (record.reason === 'below_threshold' || record.reason === 'below_similarity_floor') return record.reason;
  return 'below_similarity_floor';
}

function resolveCandidates(
  profile: Profile,
  refusal: RefusalRecord | null,
  candidates: Candidate[],
  preRefusalCandidates: Candidate[] | undefined,
): Candidate[] {
  if (refusal?.decision === 'refuse' && profile === 'eval' && preRefusalCandidates) return preRefusalCandidates;
  if (refusal?.decision === 'refuse') return [];
  return candidates;
}

export async function buildV2Result(ctx: BuildV2ResultInput): Promise<RetrievalResult> {
  const {
    input,
    config,
    profile,
    params,
    embedding,
    assembly,
    candidates,
    collector,
    queryContext,
    refusal,
    queryLanguage = null,
    preRefusalCandidates,
  } = ctx;
  const records = collector.stages();
  const outputCandidates = resolveCandidates(profile, refusal, candidates, preRefusalCandidates);
  const survivors = assembly ? survivorCount(assembly) : outputCandidates.length;

  let status = assembleDisabledStatus(records, deriveStatus(records, survivors), assembly ? 1 : 0);
  let reason =
    status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? outputCandidates.length === 0
          ? 'no_candidates'
          : 'no_relevant_context'
        : degradedReason(records);

  if (refusal?.decision === 'refuse') {
    status = 'empty';
    reason = refusedReason(refusal);
  }

  const { configHash: thresholdsConfigHash } = loadThresholds();
  const chunking = await getActiveChunkingProfiles();
  const profileId = embedding.profile?.id ?? LEGACY_PROFILE.id;
  const retrievalConfigHash = computeRetrievalConfigHash({
    backendId: getRetrievalBackend().id,
    embeddingProfileId: profileId,
    lexicalVersion: LEXICAL_VERSION,
    rerankTextVersion: RERANK_TEXT_VERSION,
    params: effectiveRetrievalParams(profile, config, evalRetrievalOverrides(profile, input.stageOverrides?.retrievalOverrides)),
    reranker: describeReranker(config, profile, queryLanguage ?? '', input.stageOverrides?.retrievalOverrides),
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
    return { ...base, candidates: outputCandidates, retrievalConfigHash, refusal, queryLanguage };
  }

  return {
    ...base,
    candidates: outputCandidates,
    context: assembly.context,
    usedDocuments: assembly.usedDocuments,
    sourceImages: assembly.sourceImages,
    links: assembly.links,
    relevantChunks: assembly.relevantChunks,
    kept: assembly.kept,
    queryTerms: assembly.queryTerms,
    refusalCandidate: assembly.refusalCandidate,
    retrievalConfigHash,
    refusal,
    queryLanguage,
  };
}