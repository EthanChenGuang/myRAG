import { getRetrievalBackend } from '../backend/registry';
import { CORE_STAGES, QUERY_LAYER_STAGES, type RagConfig } from '../config';
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
import type { Candidate, InjectionSummary, Profile, RetrievalResult, RunRetrievalInput, StageRecord } from '../types';
import type { CacheHit, CacheTicket } from '../cache/types';
import type { TemporalQueryContext } from '../query/temporal-query-detector';
import { isMultiTenant } from '@/lib/deployment-mode';
import { getRagDeps } from '../deps';
import type { SecurityConfig } from '../security/config';
import { computeRetrievalConfigHash, securityHashComponent, type RetrievalConfigHashQueryLayer } from './config-hash';
import { effectiveRetrievalParams } from './retrieval-params';
import type { AssembleOutput } from '../context/assemble';
import type { QueryPlan, RetrievalParams } from '@/lib/rag-eval/contracts.generated';

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
  /** The query layer's plan; absent while the layer is off, so the result stays identical to Phase 4. */
  queryPlan?: QueryPlan | null;
  /** True when the query layer served the translate stage (D-24): its record is then soft like the other layer stages. */
  layerTranslate?: boolean;
  /** The query-layer part of the config hash; present only while the layer ran (research A-7). */
  queryLayerHash?: RetrievalConfigHashQueryLayer;
  /** The semantic_cache stage's store ticket (D-32). */
  cacheTicket?: CacheTicket;
}

export interface RequestConfigHashInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  embeddingProfileId: string;
  queryLanguage: string | null;
  security: SecurityConfig;
  bindingHash?: { embeddingBindings?: Record<string, string>; domainControlLeg?: string };
  queryLayerHash?: RetrievalConfigHashQueryLayer;
}

/** The request's retrieval-config hash; the result and the semantic-cache key both use it, so they never disagree. */
export async function requestRetrievalConfigHash(ctx: RequestConfigHashInput): Promise<string> {
  const { input, config, profile, queryLanguage, security } = ctx;
  const { configHash: thresholdsConfigHash } = loadThresholds();
  const chunking = await getActiveChunkingProfiles();
  return computeRetrievalConfigHash({
    backendId: getRetrievalBackend().id,
    embeddingProfileId: ctx.embeddingProfileId,
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
    ...(ctx.queryLayerHash ? { queryLayer: ctx.queryLayerHash } : {}),
  });
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

const QUERY_LAYER_STAGE_NAMES: ReadonlySet<string> = new Set(QUERY_LAYER_STAGES);
const CORE_STAGE_NAMES: ReadonlySet<string> = new Set(CORE_STAGES);

/**
 * A-2: query-layer stages are soft. semantic_cache never affects the status; the other query-layer stages are left out
 * only when nothing survived and every core stage (embed, the original-query search, fuse) is ok, so a slow optional
 * transform cannot turn a legitimate empty answer into a degraded one. The records themselves stay in the trace.
 */
export function statusRecords(records: readonly StageRecord[], survivors: number, layerTranslate = false): StageRecord[] {
  const withoutCache = records.filter((record) => record.name !== 'semantic_cache');
  if (survivors > 0) return withoutCache;
  const core = records.filter((record) => CORE_STAGE_NAMES.has(record.name));
  const coreOk = core.length > 0 && core.every((record) => record.status === 'ok');
  if (!coreOk) return withoutCache;
  return withoutCache.filter((record) => !QUERY_LAYER_STAGE_NAMES.has(record.name) && !(layerTranslate && record.name === 'translate'));
}

/** D-10: small talk under the query layer skips retrieval; ok with an empty context, never a refusal candidate. */
export function buildSmallTalkResult(ctx: {
  collector: TraceCollector;
  profile: Profile;
  queryContext: TemporalQueryContext | null;
  queryLanguage: string | null;
  queryPlan: QueryPlan | null;
}): RetrievalResult {
  const base = failure(ctx.collector, 'ok', 'small_talk', ctx.queryContext);
  return {
    ...base,
    ...(ctx.queryPlan ? { queryPlan: ctx.queryPlan } : {}),
    ...(ctx.profile === 'voice' ? { voice: { results: [], source_images: [] } } : {}),
    refusal: null,
    queryLanguage: ctx.queryLanguage,
  };
}

/** D-32: a semantic-cache hit skips search, rank and context; ok with the cached answer for the entry point to stream. */
export function buildCacheHitResult(ctx: {
  collector: TraceCollector;
  queryContext: TemporalQueryContext | null;
  queryLanguage: string | null;
  queryPlan: QueryPlan | null;
  cacheHit: CacheHit;
  retrievalConfigHash?: string;
}): RetrievalResult {
  const base = failure(ctx.collector, 'ok', 'cache_hit', ctx.queryContext);
  return {
    ...base,
    ...(ctx.queryPlan ? { queryPlan: ctx.queryPlan } : {}),
    ...(ctx.retrievalConfigHash ? { retrievalConfigHash: ctx.retrievalConfigHash } : {}),
    cacheHit: ctx.cacheHit,
    refusal: null,
    queryLanguage: ctx.queryLanguage,
  };
}

/** D-32: true only for the semantic-cache short-circuit. */
export function isCacheHitResult(result: Pick<RetrievalResult, 'status' | 'reason' | 'cacheHit'> | null | undefined): boolean {
  return result?.status === 'ok' && result.reason === 'cache_hit' && result.cacheHit !== undefined;
}

/** D-10: true only for the query layer's small-talk short-circuit, never for an ordinary ok result. */
export function isSmallTalkResult(result: Pick<RetrievalResult, 'status' | 'reason' | 'queryPlan'> | null | undefined): boolean {
  return result?.status === 'ok' && result.reason === 'small_talk' && result.queryPlan?.gate.skip_retrieval === true;
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
    queryPlan = null,
    layerTranslate = false,
  } = ctx;
  const security = ctx.security ?? getRagDeps().securityConfig();
  const records = collector.stages();
  const outputCandidates = resolveCandidates(profile, refusal, candidates, preRefusalCandidates);
  const voiceCount = voice?.results.length ?? 0;
  const survivors = profile === 'voice' ? voiceCount : assembly ? survivorCount(assembly) : outputCandidates.length;
  const assemblyWeight = profile === 'voice' ? (voiceCount > 0 ? 1 : 0) : assembly ? 1 : 0;

  const derived = assembleDisabledStatus(records, deriveStatus(statusRecords(records, survivors, layerTranslate), survivors), assemblyWeight);
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

  const retrievalConfigHash = await requestRetrievalConfigHash({
    input,
    config,
    profile,
    embeddingProfileId: embedding.profile?.id ?? LEGACY_PROFILE.id,
    queryLanguage,
    security,
    ...(ctx.bindingHash ? { bindingHash: ctx.bindingHash } : {}),
    ...(ctx.queryLayerHash ? { queryLayerHash: ctx.queryLayerHash } : {}),
  });

  const base = {
    ...failure(collector, status, reason, queryContext),
    ...(injection ? { injection } : {}),
    ...(queryPlan ? { queryPlan } : {}),
    ...(ctx.cacheTicket && profile !== 'voice' ? { cacheTicket: ctx.cacheTicket } : {}),
  };

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