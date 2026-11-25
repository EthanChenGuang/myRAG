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
import { runContextStages } from './stages/context';
import { runQueryStages } from './stages/query';
import { runRankStages } from './stages/rank';
import { runSearchStages } from './stages/search';
import { buildV2Result, fusedHitsToVoiceChunks } from './result';

export const V2_PROFILES = ['chat', 'embed', 'eval', 'voice'] as const;

const VOICE_DEFAULT_MATCH_COUNT = 5;

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

/** The document rows the scoped search returned for these hits (one per document version); no extra read. */
function documentRowsOf(hits: readonly FusedHit[]): Array<{ id: string; metadata: Record<string, unknown> | null }> {
  const rows = new Map<string, { id: string; metadata: Record<string, unknown> | null }>();
  for (const row of hits) {
    if (!rows.has(row.hit.documentId)) rows.set(row.hit.documentId, { id: row.hit.documentId, metadata: row.hit.document.metadata });
  }
  return [...rows.values()];
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
  const security = deps.securityConfig();
  if (security.injectionCheck !== 'off') warnInjectionCheckDisabled(config, security.injectionCheck);

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
      });
      assembly = context.assembly;
      candidates = context.candidates;
      injection = context.injection;
      injectionStalled = context.injectionStalled ?? false;
    }
    if (profile === 'eval' && rank.decision.decision === 'refuse') {
      const dropped = new Set(injection?.droppedChunkIds ?? []);
      preRefusalCandidates = rank.preRefusalHits.filter((row) => !dropped.has(row.hit.chunkId)).map((row, index) => ({
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
    voice,
    injection,
    injectionStalled,
  });
}

export function isV2RetrievalProfile(profile: Profile): boolean {
  return (V2_PROFILES as readonly string[]).includes(profile);
}