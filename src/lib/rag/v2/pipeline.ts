import { logger } from '@/lib/logger';
import { describeStageCause } from '../stage-error-cause';
import { RetrievalBackendError } from '../backend/supabase-rpc';
import { isMissingPhase4Function, markV2Unavailable, resolveEffectivePipeline, V2_UNAVAILABLE } from './readiness';
import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import { classifyProfileFailure, type QueryEmbedding } from '../embeddings/query-embedding';
import { assembleVoiceResults, voiceContext, type VoiceResults } from '../context/voice';
import { validResultCount, warnInjectionCheckDisabled } from '../config';
import { downweightOrder, failure, injectionDropped, requireValue, runInjectionStage, runStage, stageSpec, StageError } from '../pipeline';
import { injectionItems, releasedRulesFromRows } from '../security/injection-check';
import { assertTenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { FusedHit } from '../fusion/rrf';
import type { Candidate, InjectionSummary, Profile, RetrievalResult, RunRetrievalInput } from '../types';
import { evalRetrievalOverrides } from './overrides';
import { effectiveRetrievalParams } from './retrieval-params';
import { evalFinalTopK, evalResultCap, runContextStages } from './stages/context';
import { runQueryStages } from './stages/query';
import { runRankStages } from './stages/rank';
import { embedForRetrieval, embedVariantTexts, runSearchStages } from './stages/search';
import {
  bindingHashFields,
  planBindingLegs,
  startBindingEmbeds,
  unresolvedEvalOverride,
  type BindingEmbed,
  type BindingLegsPlan,
} from './stages/binding-legs';
import { buildCacheHitResult, buildSmallTalkResult, buildV2Result, fusedHitsToVoiceChunks, requestRetrievalConfigHash } from './result';
import { buildRetrievalFilters, effectiveOnFor } from '../query/filters';
import { queryLanguage as detectQueryLanguage } from '../query/language';
import type { RetrievalConfigHashQueryLayer, TerminologyHashStage } from './config-hash';
import { hasTranslationWork, planTranslationLegs, translationHashFields, type TranslationLegsPlan } from './translation-legs';
import type { SemanticCacheSeam } from '../query/run-layer';
import { variantDenseTexts } from '../query/variants';

export const V2_PROFILES = ['chat', 'embed', 'eval', 'voice'] as const;

const VOICE_DEFAULT_MATCH_COUNT = 5;

const PROFILE_FAILURE_REASONS = {
  mismatch: 'embedding_profile_mismatch',
  unavailable: 'embedding_profile_unavailable',
} as const;

function profileFailureReason(original: unknown): string | null {
  const kind = classifyProfileFailure(original);
  return kind ? PROFILE_FAILURE_REASONS[kind] : null;
}

/** The document rows the scoped search returned for these hits (one per document version); no extra read. */
function documentRowsOf(hits: readonly FusedHit[]): Array<{ id: string; metadata: Record<string, unknown> | null }> {
  const rows = new Map<string, { id: string; metadata: Record<string, unknown> | null }>();
  for (const row of hits) {
    if (!rows.has(row.hit.documentId)) rows.set(row.hit.documentId, { id: row.hit.documentId, metadata: row.hit.document.metadata });
  }
  return [...rows.values()];
}

function precomputedVectors(entry: { text: string; embedding: QueryEmbedding } | undefined): Map<string, QueryEmbedding> | undefined {
  return entry ? new Map([[entry.text, entry.embedding]]) : undefined;
}

/** The query-layer part of the config hash (research A-7); loaded only while the layer is on, so run-layer stays unimported otherwise. */
async function queryLayerHashFor(input: RunRetrievalInput, config: ReturnType<typeof loadRagConfig>, profile: Profile): Promise<RetrievalConfigHashQueryLayer> {
  const [{ effectiveQueryLayerConfig, queryLayerOverrides }, { effectiveQueryParams }, { queryLayerHashComponent }] = await Promise.all([
    import('../query/layer-config'),
    import('../query/query-params'),
    import('../query/hash-part'),
  ]);
  const overrides = queryLayerOverrides(profile, input.stageOverrides);
  return queryLayerHashComponent(effectiveQueryLayerConfig(config.queryLayer, overrides), effectiveQueryParams(profile, overrides?.queryParams));
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
  let voice: VoiceResults | null = null;
  let injection: InjectionSummary | undefined;
  let injectionStalled = false;
  let bindingPlan: BindingLegsPlan | null = null;
  let queryPlan: RetrievalResult['queryPlan'] | null = null;
  let layerTranslate = false;
  let effectiveOn: string | undefined;
  let queryLayerHash: RetrievalConfigHashQueryLayer | undefined;
  let cacheTicket: RetrievalResult['cacheTicket'];
  // D-21: set by the terminology stage before semantic_cache builds its key; enabled but not reached reads as unavailable.
  let terminologyStage: TerminologyHashStage = spec('terminology', 'skip').enabled ? { enabled: true, version: null } : { enabled: false };
  const security = deps.securityConfig();
  if (security.injectionCheck !== 'off') warnInjectionCheckDisabled(config, security.injectionCheck);

  // D-18: the binding plan reads only the request's doc-type filter, so the cache stage may plan it before the query stages end.
  let earlyBindingPlan: Promise<BindingLegsPlan> | null = null;
  const planBindingsEarly = (): Promise<BindingLegsPlan> =>
    (earlyBindingPlan ??= planBindingLegs({
      profile,
      config,
      scope,
      filters: buildRetrievalFilters({ explicit: input.retrievalFilters, referencedDocumentIds: [] }),
      options: input.options,
    }));
  const layerHash = async (): Promise<RetrievalConfigHashQueryLayer> => {
    queryLayerHash ??= await queryLayerHashFor(input, config, profile);
    return queryLayerHash;
  };
  // XLG-04: one translation state lookup per request and embedding profile, shared by the cache key and the search stage.
  const translationPlans = new Map<string, Promise<TranslationLegsPlan>>();
  const planTranslations = (embeddingProfileId: string): Promise<TranslationLegsPlan> => {
    let pending = translationPlans.get(embeddingProfileId);
    if (!pending) {
      pending = planTranslationLegs({
        profile,
        config,
        scope,
        queryLanguage: detectQueryLanguage(input.query),
        embeddingProfileId,
        signal,
      });
      translationPlans.set(embeddingProfileId, pending);
    }
    return pending;
  };
  let translationPlan: TranslationLegsPlan | null = null;
  const cacheSeam: SemanticCacheSeam = {
    embed: async (text, embedSignal) => (await embedForRetrieval(input, [text], embedSignal))[0]!,
    retrievalConfigHash: async (embedded) =>
      requestRetrievalConfigHash({
        input,
        config,
        profile,
        embeddingProfileId: embedded.profile?.id ?? LEGACY_PROFILE.id,
        queryLanguage: detectQueryLanguage(input.query),
        security,
        bindingHash: bindingHashFields(await planBindingsEarly()),
        translationHash: translationHashFields(await planTranslations(embedded.profile?.id ?? LEGACY_PROFILE.id), params),
        queryLayerHash: await layerHash(),
        ...(config.effectiveDates ? { effectiveOn: effectiveOnFor(config, deps.now()) } : {}),
        terminology: terminologyStage,
      }),
  };

  try {
    const query = await runQueryStages({
      input,
      scope,
      config,
      profile,
      signal,
      collector,
      stageOverrides: input.stageOverrides,
      cache: cacheSeam,
      onTerminology: (stage) => {
        terminologyStage = stage;
      },
    });
    queryContext = query.queryContext;
    queryLanguage = query.queryLanguage;
    queryPlan = query.queryLayer?.plan ?? null;
    layerTranslate = query.queryLayer?.handledTranslate === true;
    effectiveOn = query.filters.effectiveOn;
    if (query.queryLayer) await layerHash();
    cacheTicket = query.queryLayer?.cacheTicket;

    // D-10: small talk under the layer skips the search, rank and context groups; the model answers without KB context.
    if (query.queryLayer?.shortCircuit?.kind === 'small_talk') {
      return buildSmallTalkResult({ collector, profile, queryContext, queryLanguage, queryPlan });
    }

    // D-32: a cache hit skips the search, rank and context groups; the entry point streams the cached answer.
    if (query.queryLayer?.shortCircuit?.kind === 'cache_hit' && query.queryLayer.cacheHit) {
      return buildCacheHitResult({
        collector,
        queryContext,
        queryLanguage,
        queryPlan,
        cacheHit: query.queryLayer.cacheHit,
        ...(query.queryLayer.cacheTicket ? { retrievalConfigHash: query.queryLayer.cacheTicket.key.retrievalConfigHash } : {}),
      });
    }

    // D-18: planned before the embed stage, so the binding map is known before anything reads the config hash.
    bindingPlan = earlyBindingPlan
      ? await earlyBindingPlan
      : await planBindingLegs({ profile, config, scope, filters: query.filters, options: input.options });
    // 03.1.1-10: an eval binding override naming a profile that cannot be resolved fails the request; it never measures the global profile.
    const unresolved = profile === 'eval' ? unresolvedEvalOverride(bindingPlan) : null;
    if (unresolved) {
      const reason = unresolved.resolveFailure === 'mismatch' ? PROFILE_FAILURE_REASONS.mismatch : PROFILE_FAILURE_REASONS.unavailable;
      const at = collector.now();
      collector.record({
        name: 'embed',
        status: 'error',
        reason: 'failed',
        startedAt: at,
        endedAt: at,
        detail: `${unresolved.resolveKind ?? unresolved.resolveFailure}:${unresolved.docType}`,
      });
      return failure(collector, 'error', reason, queryContext);
    }
    const originalText = query.variants.find((variant) => variant.kind === 'original')?.text ?? input.query;
    const bindingEmbeds: Promise<BindingEmbed>[] =
      bindingPlan.legs.length > 0 ? startBindingEmbeds(bindingPlan.legs, originalText, signal, config.v2.domainEmbeddings.timeoutMs) : [];

    const variantEmbeddings = requireValue(
      await runStage(
        spec('embed', 'throw'),
        signal,
        (stageSignal) =>
          embedVariantTexts(input, variantDenseTexts(query.variants), stageSignal, precomputedVectors(query.queryLayer?.precomputed)),
        collector,
        { detail: (value) => value[0]?.profile?.id },
      ),
      'embed',
    );
    embedding = variantEmbeddings[0]!;
    translationPlan = await planTranslations(embedding.profile?.id ?? LEGACY_PROFILE.id);

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
      ...(query.queryLayer ? { trackStandalone: true } : {}),
      filters: query.filters,
      bindings: { plan: bindingPlan, embeds: bindingEmbeds },
      ...(hasTranslationWork(translationPlan) ? { translations: translationPlan } : {}),
      // D-31: term:0 is searched only when the stage's accounting kept it.
      ...(query.terminology && query.terminology.termSearch && query.terminology.expansionTokens.length > 0
        ? {
            terminology: {
              tokens: query.terminology.expansionTokens,
              expansionWeight: query.terminology.expansionWeight,
              reserveSlots: query.terminology.reserveSlots,
            },
          }
        : {}),
      ...(query.terminology ? { terminologyDenseWeight: query.terminology.denseWeight } : {}),
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
      queryContext: query.queryContext,
      ...(query.queryLayer
        ? {
            queryPlan,
            coverage: {
              enabled: params.sub_question_coverage,
              topK:
                profile === 'voice'
                  ? (validResultCount(input.options?.maxResults) ?? VOICE_DEFAULT_MATCH_COUNT)
                  : evalFinalTopK(profile, input, params.final_top_k),
            },
          }
        : {}),
    });
    refusal = rank.decision;

    if (profile === 'voice') {
      const matchCount = validResultCount(input.options?.maxResults) ?? VOICE_DEFAULT_MATCH_COUNT;
      let chunks = fusedHitsToVoiceChunks(rank.survivors, rank.rerank.scoreByChunk);
      let flaggedForRender: ReadonlySet<string> | undefined;
      if (security.injectionCheck !== 'off') {
        // Voice runs the rules only (injectionDetectorsFor); released ids come from the scoped search rows.
        const run = await runInjectionStage({
          spec: spec('injection_check', 'skip'),
          signal,
          collector,
          scope,
          profile,
          security,
          mode: security.injectionCheck,
          items: injectionItems(chunks, null, null),
          candidates: chunks,
          referenced: null,
          released: releasedRulesFromRows(documentRowsOf(rank.survivors)),
        });
        injectionStalled = run.stalled;
        if (run.applied) {
          injection = run.applied.summary;
          if (injectionDropped(run.applied.summary)) chunks = run.applied.candidates;
          if (run.applied.marks) {
            flaggedForRender = run.applied.marks.chunkIds;
            chunks = downweightOrder(chunks, flaggedForRender);
          }
        }
      }
      const voiceChunks = chunks;
      const assembled = await runStage(
        spec('assemble', 'skip'),
        signal,
        () => assembleVoiceResults({ query: input.query, chunks: voiceChunks, matchCount }),
        collector,
        { candidatesIn: voiceChunks.length, candidatesOut: (value) => value.results.length },
      );
      voice = assembled.skipped ? { results: [], source_images: [] } : assembled.value;
      if (security.contextTagging && !assembled.skipped) {
        const context = voiceContext(voice.results, flaggedForRender);
        if (context !== null) voice = { ...voice, context };
      }
    } else {
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
        security,
        versionScope: search.versionScope,
        queryLanguage: query.queryLanguage,
      });
      assembly = context.assembly;
      candidates = context.candidates;
      injection = context.injection;
      injectionStalled = context.injectionStalled ?? false;
    }
    if (profile === 'eval' && rank.decision.decision === 'refuse') {
      const dropped = new Set(injection?.droppedChunkIds ?? []);
      const cap = evalResultCap(profile, input);
      const kept = rank.preRefusalHits.filter((row) => !dropped.has(row.hit.chunkId));
      preRefusalCandidates = (cap === null ? kept : kept.slice(0, cap)).map((row) => ({
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
        ...(row.standaloneSimilarity !== undefined ? { standaloneSimilarity: row.standaloneSimilarity } : {}),
      }));
    }
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', queryContext);
      const profileReason = profileFailureReason(error.original);
      if (profileReason) return failure(collector, 'error', profileReason, queryContext);
      if (error.original instanceof RetrievalBackendError) {
        // D-07: only a defaulted v2 turns a missing Phase 4 function into a legacy fallback; an explicit v2 keeps backend_error.
        if (isMissingPhase4Function(error.original) && resolveEffectivePipeline().source === 'default') {
          markV2Unavailable(error.original.rpc);
          return failure(collector, 'error', V2_UNAVAILABLE, queryContext);
        }
        logger.error('RAG Pipeline', 'Backend error', { rpc: error.original.rpc, code: error.original.code });
        return failure(collector, 'error', 'backend_error', queryContext);
      }
      logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason, ...describeStageCause(error.original) });
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
    voice,
    injection,
    injectionStalled,
    security,
    ...(bindingPlan ? { bindingHash: bindingHashFields(bindingPlan) } : {}),
    ...(translationPlan ? { translationHash: translationHashFields(translationPlan, params) } : {}),
    queryPlan,
    ...(layerTranslate ? { layerTranslate } : {}),
    ...(effectiveOn ? { effectiveOn } : {}),
    ...(queryLayerHash ? { queryLayerHash } : {}),
    ...(cacheTicket ? { cacheTicket } : {}),
    terminology: terminologyStage,
  });
}

export function isV2RetrievalProfile(profile: Profile): boolean {
  return (V2_PROFILES as readonly string[]).includes(profile);
}