import { getRetrievalBackend } from '../backend/registry';
import type { RagConfig } from '../config';
import { getActiveChunkingProfiles } from '../chunking/active';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import { LEXICAL_VERSION } from '../lexical/chunk-text';
import type { FusedHit } from '../fusion/rrf';
import type { ChunkWithScore } from '../rerank/local-hybrid';
import { assembleDisabledStatus, deriveStatus, failure, injectionFilteredAll, injectionReason } from '../pipeline';
import type { VoiceResults } from '../context/voice';
import { evalRetrievalOverrides, hashedChunkingProfiles } from './overrides';
import { loadThresholds } from '../refusal/thresholds';
import type { RefusalRecord } from '../refusal/types';
import { describeReranker } from '../rerank/select';
import { RERANK_TEXT_VERSION } from '../rerank/types';
import type { TraceCollector } from '../trace/collector';
import type { Candidate, InjectionSummary, Profile, RetrievalResult, RunRetrievalInput } from '../types';
import type { TemporalQueryContext } from '../query/temporal-query-detector';
import { isMultiTenant } from '@/lib/deployment-mode';
import { getRagDeps } from '../deps';
import type { SecurityConfig } from '../security/config';
import { computeRetrievalConfigHash, securityHashComponent } from './config-hash';
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
  /** Wire payload from assembleVoiceResults in runV2Pipeline when profile is voice. */
  voice?: VoiceResults | null;
  /** The injection_check summary; absent when RAG_INJECTION_CHECK is off. */
  injection?: InjectionSummary;
  injectionStalled?: boolean;
  /** The request's security config; defaults to RagDeps.securityConfig(). */
  security?: SecurityConfig;
  /** The planned binding legs (bindingHashFields); empty when none is planned. */
  bindingHash?: { embeddingBindings?: Record<string, string>; domainControlLeg?: string };
}

export function fusedHitsToVoiceChunks(hits: FusedHit[], scoreByChunk?: Map<string, number>): ChunkWithScore[] {
  return hits.map((row) => {
    const chunkId = row.hit.chunkId;
    const rerankScore = scoreByChunk?.get(chunkId);
    const chunk: ChunkWithScore = {
      chunk_id: chunkId,
      document_id: row.hit.documentId,
      content: row.hit.content,
      similarity: row.hit.similarity ?? 0,
      metadata: row.hit.metadata ?? undefined,
      ...(rerankScore !== undefined ? { rerankScore } : {}),
    };
    return chunk;
  });
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
    voice = null,
    injection,
    injectionStalled = false,
  } = ctx;
  const security = ctx.security ?? getRagDeps().securityConfig();
  const records = collector.stages();
  const outputCandidates = resolveCandidates(profile, refusal, candidates, preRefusalCandidates);
  const voiceCount = voice?.results.length ?? 0;
  const survivors = profile === 'voice' ? voiceCount : assembly ? survivorCount(assembly) : outputCandidates.length;
  const assemblyWeight = profile === 'voice' ? (voiceCount > 0 ? 1 : 0) : assembly ? 1 : 0;

  const derived = assembleDisabledStatus(records, deriveStatus(records, survivors), assemblyWeight);
  const injectionFiltered = (profile === 'voice' || assembly !== null) && injectionFilteredAll(injection, survivors, derived);
  let status: RetrievalResult['status'] = injectionFiltered ? 'empty' : derived;
  let reason = injectionFiltered
    ? 'injection_filtered'
    : status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? outputCandidates.length === 0
          ? 'no_candidates'
          : 'no_relevant_context'
        : injectionReason(records, injectionStalled);

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
    activeChunkingProfiles: hashedChunkingProfiles(profile, chunking, input.stageOverrides?.retrievalOverrides),
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
      ...(config.monolingual ? { monolingual: true as const } : {}),
    },
    security: securityHashComponent(security, { multiTenant: isMultiTenant() }),
    ...(ctx.bindingHash ?? {}),
  });

  const base = { ...failure(collector, status, reason, queryContext), ...(injection ? { injection } : {}) };

  if (profile === 'voice') {
    return {
      ...base,
      candidates: outputCandidates,
      voice: voice ?? { results: [], source_images: [] },
      retrievalConfigHash,
      refusal,
      queryLanguage,
    };
  }

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
    blocks: assembly.blocks,
    retrievalConfigHash,
    refusal,
    queryLanguage,
  };
}