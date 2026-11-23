import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { RetrievalBackendError, vectorSearch, type RawChunk, type RpcClient } from './backend/supabase-rpc';
import {
  CORE_STAGES,
  FALLBACK_STAGE_TIMEOUT_MS,
  loadRagConfig,
  resolveFinalResultCount,
  validResultCount,
  type RagConfig,
  type StageName,
} from './config';
import {
  buildContext,
  filterCandidates,
  type AssembleInput,
  type AssembleOutput,
  type FilteredCandidates,
} from './context/assemble';
import { fetchAssemblyRows, type AssemblyRows } from './context/fetch-rows';
import { formatImageContext, formatVideoContext } from './context/media';
import {
  OVERVIEW_MATCH_COUNT,
  OVERVIEW_QUERY,
  OVERVIEW_SIMILARITY_THRESHOLD,
  assembleOverviewContext,
  fetchOverviewDocuments,
  type OverviewContext,
} from './context/overview';
import { assembleVoiceResults, enrichVoiceCandidates, type VoiceResults } from './context/voice';
import { getRagDeps, type RagDeps } from './deps';
import { legacyAnalyze, legacyRank, legacySearch } from './legacy/enhanced-retrieval';
import { defaultQueryContext } from './query/temporal-query-detector';
import { resolveDocumentRefs } from './refs/resolve';
import { hybridRerank } from './rerank/local-hybrid';
import { assertTenantScope, scopeKey } from './tenant/scope';
import { createTraceCollector, type TraceCollector } from './trace/collector';
import { finishTrace } from './trace/finish';
import { voiceKeywordFallback, type VoiceChunk } from './voice/keyword-fallback';
import type {
  Candidate,
  Profile,
  ReferencedState,
  RetrievalResult,
  RunRetrievalInput,
  StageFailureReason,
  StageOverrides,
  StageRecord,
} from './types';

export interface StageSpec {
  name: StageName;
  enabled: boolean;
  timeoutMs: number;
  onFail: 'skip' | 'throw';
}

export type StageOutcome<T> =
  | { skipped: false; value: T }
  | { skipped: true; reason: 'disabled' | 'failed' | 'timeout' };

export interface StageRunOptions<T> {
  candidatesIn?: number | null;
  candidatesOut?: (value: T) => number | null;
  detail?: (value: T) => string | undefined;
}

export class StageError extends Error {
  readonly stage: string;
  readonly reason: StageFailureReason;
  readonly original: unknown;

  constructor(stage: string, reason: StageFailureReason, original?: unknown) {
    super(`[RAG Pipeline] stage ${stage} ${reason}`);
    this.name = 'StageError';
    this.stage = stage;
    this.reason = reason;
    this.original = original;
  }
}

const MIN_OVERRIDE_TIMEOUT_MS = 1;
const MAX_OVERRIDE_TIMEOUT_MS = 60000;

function runAgainstSignal<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => fn(signal))
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export async function runStage<T>(
  spec: StageSpec,
  parent: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T> | T,
  collector: TraceCollector,
  options: StageRunOptions<T> = {},
): Promise<StageOutcome<T>> {
  if (parent.aborted) throw new StageError(spec.name, 'aborted', parent.reason);

  const candidatesIn = options.candidatesIn ?? null;

  if (!spec.enabled) {
    const at = collector.now();
    collector.record({ name: spec.name, status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at, candidatesIn });
    return { skipped: true, reason: 'disabled' };
  }

  const signal = AbortSignal.any([parent, AbortSignal.timeout(spec.timeoutMs)]);
  const startedAt = collector.now();

  try {
    const value = await runAgainstSignal(signal, fn);
    signal.throwIfAborted();
    collector.record({
      name: spec.name,
      status: 'ok',
      startedAt,
      endedAt: collector.now(),
      candidatesIn,
      candidatesOut: options.candidatesOut ? options.candidatesOut(value) : null,
      detail: options.detail ? options.detail(value) : undefined,
    });
    return { skipped: false, value };
  } catch (error) {
    const reason: StageFailureReason = parent.aborted ? 'aborted' : signal.aborted ? 'timeout' : 'failed';
    const endedAt = collector.now();

    if (reason === 'aborted') {
      collector.record({ name: spec.name, status: 'aborted', reason, startedAt, endedAt, candidatesIn });
      throw new StageError(spec.name, reason, error);
    }

    if (spec.onFail === 'throw') {
      collector.record({
        name: spec.name,
        status: reason === 'timeout' ? 'timeout' : 'error',
        reason,
        startedAt,
        endedAt,
        candidatesIn,
      });
      throw new StageError(spec.name, reason, error);
    }

    collector.record({ name: spec.name, status: 'skipped', reason, startedAt, endedAt, candidatesIn });
    logger.warn('RAG Pipeline', 'Optional stage skipped', { stage: spec.name, reason });
    return { skipped: true, reason };
  }
}

export function deriveStatus(records: StageRecord[], survivingCount: number): RetrievalResult['status'] {
  if (records.some((record) => record.status === 'error' || record.status === 'timeout' || record.status === 'aborted')) {
    return 'error';
  }
  if (records.some((record) => record.status === 'skipped')) return 'degraded';
  return survivingCount === 0 ? 'empty' : 'ok';
}

function stageSpec(
  config: RagConfig,
  profile: Profile,
  name: StageName,
  onFail: StageSpec['onFail'],
  overrides: StageOverrides | undefined,
): StageSpec {
  const core = (CORE_STAGES as readonly string[]).includes(name);
  const requestOverrides = profile === 'eval' ? overrides : undefined;

  const enabled =
    core || !(config.disabledStages.has(name) || (requestOverrides?.disabledStages ?? []).includes(name));

  const requested = requestOverrides?.timeouts?.[name];
  const validRequested =
    requested !== undefined &&
    Number.isInteger(requested) &&
    requested >= MIN_OVERRIDE_TIMEOUT_MS &&
    requested <= MAX_OVERRIDE_TIMEOUT_MS;
  const timeoutMs = validRequested ? requested : (config.timeouts[profile][name] ?? FALLBACK_STAGE_TIMEOUT_MS);

  return { name, enabled, timeoutMs, onFail };
}

function requireValue<T>(outcome: StageOutcome<T>, stage: string): T {
  if (outcome.skipped) throw new StageError(stage, 'failed');
  return outcome.value;
}

const ASSEMBLY_PROFILES: readonly Profile[] = ['chat', 'embed', 'eval'];
const EMPTY_ROWS: AssemblyRows = { documents: new Map(), chunkMetadata: new Map() };

async function loadRows(candidates: Candidate[], signal: AbortSignal): Promise<AssemblyRows> {
  if (candidates.length === 0) return EMPTY_ROWS;
  const adminClient = getRagDeps().adminClient();
  if (!adminClient) throw new Error('[RAG Assemble] admin client unavailable');
  return fetchAssemblyRows(candidates, { adminClient, signal });
}

function requireAdminSearchClient(deps: RagDeps): RpcClient {
  const admin = deps.adminClient();
  if (!admin) throw new Error('[RAG Search] admin client unavailable');
  return admin as unknown as RpcClient;
}

function survivorCount(assembly: AssembleOutput<Candidate>): number {
  return assembly.usedDocuments.length + assembly.relevantChunks.length;
}

function failure(
  collector: TraceCollector,
  status: RetrievalResult['status'],
  reason: string,
  queryContext: RetrievalResult['queryContext'],
): RetrievalResult {
  return {
    status,
    reason,
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: collector.stages(),
    traceId: collector.traceId,
    queryContext,
  };
}

function assembleDisabledStatus(
  records: StageRecord[],
  status: RetrievalResult['status'],
  reachedAssemble: number,
): RetrievalResult['status'] {
  if (status !== 'ok' && status !== 'empty') return status;
  if (reachedAssemble === 0) return status;
  return records.some((record) => record.name === 'assemble' && record.status === 'disabled') ? 'degraded' : status;
}

function degradedReason(records: StageRecord[]): string {
  const skipped = records.find((record) => record.status === 'skipped');
  if (skipped) return `${skipped.name}_${skipped.reason ?? 'skipped'}`;
  return records.some((record) => record.name === 'assemble' && record.status === 'disabled') ? 'assemble_disabled' : 'degraded';
}

const MEDIA_MATCH_COUNT = 10;
const MEDIA_SIMILARITY_THRESHOLD = 0.3;

async function runMediaPipeline(input: RunRetrievalInput, collector: TraceCollector, scope: NonNullable<RunRetrievalInput['scope']>): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const { signal, profile } = input;
  const config = loadRagConfig(deps.ragEnv());
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, input.stageOverrides);
  const mediaKind = input.options?.mediaKind ?? 'image';

  let candidates: Candidate[] = [];
  let context = '';

  try {
    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => deps.embedder(input.query, { signal: stageSignal }), collector),
      'embed',
    );

    const rawChunks = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        (stageSignal) => {
          const adminClient = deps.adminClient();
          if (!adminClient) throw new Error('[RAG Media] admin client unavailable');
          return vectorSearch(scope, embedding, MEDIA_MATCH_COUNT, MEDIA_SIMILARITY_THRESHOLD, {
            client: adminClient as unknown as RpcClient,
            signal: stageSignal,
          });
        },
        collector,
        { candidatesOut: (value) => value.length },
      ),
      'search',
    );

    candidates = rawChunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      content: chunk.content,
      similarity: chunk.similarity,
      metadata: chunk.metadata,
      temporal_score: 0,
      financial_score: 0,
      final_score: chunk.similarity,
      match_reason: `similarity: ${chunk.similarity.toFixed(3)}`,
    }));

    const assembled = await runStage(
      spec('assemble', 'skip'),
      signal,
      () => (mediaKind === 'video' ? formatVideoContext(rawChunks) : formatImageContext(rawChunks)),
      collector,
      { candidatesIn: rawChunks.length, candidatesOut: (value) => (value === '' ? 0 : rawChunks.length) },
    );
    context = assembled.skipped ? '' : assembled.value;
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', null);
      if (error.original instanceof RetrievalBackendError) {
        logger.error('RAG Pipeline', 'Backend error', { rpc: error.original.rpc, code: error.original.code });
        return failure(collector, 'error', 'backend_error', null);
      }
      logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason });
      return failure(collector, 'error', `${error.stage}_${error.reason}`, null);
    }
    if (signal.aborted) return failure(collector, 'error', 'aborted', null);
    throw error;
  }

  const records = collector.stages();
  const status = deriveStatus(records, candidates.length);
  const reason = status === 'ok' ? 'ok' : status === 'empty' ? 'no_candidates' : degradedReason(records);
  return { ...failure(collector, status, reason, null), candidates, context };
}

async function runRefsStage(
  input: RunRetrievalInput,
  scope: NonNullable<RunRetrievalInput['scope']>,
  stage: StageSpec,
  collector: TraceCollector,
): Promise<ReferencedState | null> {
  const documentRefs = input.documentRefs;
  if (!documentRefs || (documentRefs.mentions.length === 0 && documentRefs.documentParts.length === 0)) return null;

  const resolved = await runStage(
    stage,
    input.signal,
    (stageSignal) => {
      const admin = getRagDeps().adminClient();
      if (!admin) throw new Error('[RAG Refs] admin client unavailable');
      return resolveDocumentRefs({
        scope,
        mentions: documentRefs.mentions,
        documentParts: documentRefs.documentParts,
        admin,
        signal: stageSignal,
      });
    },
    collector,
    { candidatesOut: (value) => value.usedDocuments.length },
  );
  return resolved.skipped ? null : { usedDocuments: resolved.value.usedDocuments, context: resolved.value.context };
}

async function runOverviewPipeline(
  input: RunRetrievalInput,
  collector: TraceCollector,
  scope: NonNullable<RunRetrievalInput['scope']>,
): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const { signal, profile } = input;
  const config = loadRagConfig(deps.ragEnv());
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, input.stageOverrides);

  let rawChunks: RawChunk[] = [];
  let overview: OverviewContext = { context: '', usedDocuments: [] };

  try {
    const referenced = await runRefsStage(input, scope, spec('refs', 'skip'), collector);

    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => deps.embedder(OVERVIEW_QUERY, { signal: stageSignal }), collector),
      'embed',
    );

    rawChunks = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        (stageSignal) => {
          const adminClient = deps.adminClient();
          if (!adminClient) throw new Error('[RAG Overview] admin client unavailable');
          return vectorSearch(scope, embedding, OVERVIEW_MATCH_COUNT, OVERVIEW_SIMILARITY_THRESHOLD, {
            client: adminClient as unknown as RpcClient,
            signal: stageSignal,
          });
        },
        collector,
        { candidatesOut: (value) => value.length },
      ),
      'search',
    );

    const assembled = await runStage(
      spec('assemble', 'skip'),
      signal,
      async (stageSignal) => {
        const adminClient = deps.adminClient();
        if (!adminClient) throw new Error('[RAG Overview] admin client unavailable');
        const documents = await fetchOverviewDocuments(rawChunks, { admin: adminClient, signal: stageSignal });
        return assembleOverviewContext(rawChunks, documents, referenced?.usedDocuments ?? []);
      },
      collector,
      { candidatesIn: rawChunks.length, candidatesOut: (value) => value.usedDocuments.length },
    );
    overview = assembled.skipped ? { context: '', usedDocuments: referenced?.usedDocuments ?? [] } : assembled.value;
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', null);
      if (error.original instanceof RetrievalBackendError) {
        logger.error('RAG Pipeline', 'Backend error', { rpc: error.original.rpc, code: error.original.code });
        return failure(collector, 'error', 'backend_error', null);
      }
      logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason });
      return failure(collector, 'error', `${error.stage}_${error.reason}`, null);
    }
    if (signal.aborted) return failure(collector, 'error', 'aborted', null);
    throw error;
  }

  const candidates: Candidate[] = rawChunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    content: chunk.content,
    similarity: chunk.similarity,
    metadata: chunk.metadata,
    temporal_score: 0,
    financial_score: 0,
    final_score: chunk.similarity,
    match_reason: `similarity: ${chunk.similarity.toFixed(3)}`,
  }));
  const records = collector.stages();
  const survivors = rawChunks.length + overview.usedDocuments.length;
  const status = assembleDisabledStatus(records, deriveStatus(records, survivors), survivors);
  const reason = status === 'ok' ? 'ok' : status === 'empty' ? 'no_candidates' : degradedReason(records);
  return { ...failure(collector, status, reason, null), candidates, context: overview.context, usedDocuments: overview.usedDocuments };
}

export async function runRetrieval(input: RunRetrievalInput): Promise<RetrievalResult> {
  if (input.scope !== null) assertTenantScope(input.scope);

  const ownsTrace = input.trace === undefined;
  const collector =
    input.trace ??
    createTraceCollector({ profile: input.profile, tenantKey: input.scope ? scopeKey(input.scope) : 'none' });

  const result = input.profile === 'voice' ? await runVoicePipeline(input, collector) : await runPipeline(input, collector);
  if (ownsTrace) finishTrace(collector, result, { query: input.query });
  return result;
}

async function runPipeline(input: RunRetrievalInput, collector: TraceCollector): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const scope = input.scope;

  if (scope === null) {
    return failure(collector, 'empty', 'no_tenant', null);
  }

  if (input.profile === 'media') return runMediaPipeline(input, collector, scope);
  if (input.options?.generalOverview) return runOverviewPipeline(input, collector, scope);

  const { signal, profile } = input;
  const config = loadRagConfig(deps.ragEnv());
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, input.stageOverrides);

  const maxResults = resolveFinalResultCount(input.options?.maxResults, env.RAG_FINAL_RESULT_COUNT);
  const fallbackToLowerThreshold = input.options?.fallbackToLowerThreshold ?? true;

  let queryContext: RetrievalResult['queryContext'] = null;
  let candidates: Candidate[] = [];
  let assembly: AssembleOutput<Candidate> | null = null;
  let referenced: ReferencedState | null = null;

  try {
    referenced = await runRefsStage(input, scope, spec('refs', 'skip'), collector);

    const analysis = await runStage(spec('analyze', 'skip'), signal, () => legacyAnalyze(input.query), collector);
    const analysed = analysis.skipped ? defaultQueryContext() : analysis.value;
    queryContext = analysed;

    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => deps.embedder(input.query, { signal: stageSignal }), collector),
      'embed',
    );

    const searched = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        (stageSignal) =>
          legacySearch({
            query: input.query,
            embedding,
            queryContext: analysed,
            maxResults,
            fallbackToLowerThreshold,
            scope,
            client: requireAdminSearchClient(deps),
            signal: stageSignal,
          }),
        collector,
        { candidatesOut: (value) => value.results.length, detail: (value) => value.retrievalStrategy },
      ),
      'search',
    );

    const ranked = await runStage(
      spec('legacy_rank', 'skip'),
      signal,
      () => legacyRank(searched.results, analysed),
      collector,
      { candidatesIn: searched.results.length, candidatesOut: (value) => value.length },
    );
    candidates = ranked.skipped ? searched.results : ranked.value;
    if (profile === 'eval' && input.options?.degrade === 'drop_top_candidate') candidates = candidates.slice(1);

    if ((ASSEMBLY_PROFILES as readonly string[]).includes(profile)) {
      const assemblyInput = (rows: AssemblyRows, applyRelevanceFilter: boolean): AssembleInput<Candidate> => ({
        queryText: input.query,
        candidates,
        documents: rows.documents,
        chunkMetadata: rows.chunkMetadata,
        referenced,
        isGPTModel: input.options?.isGPTModel ?? false,
        ragMode: input.options?.ragMode ?? 'strict',
        webSearchEnabled: input.options?.webSearchEnabled ?? false,
        applyRelevanceFilter,
      });

      let rows: AssemblyRows | null = null;
      let filtered: FilteredCandidates<Candidate> | null = null;

      const postFilter = await runStage(
        spec('post_filter', 'skip'),
        signal,
        async (stageSignal) => {
          const loaded = await loadRows(candidates, stageSignal);
          const result = filterCandidates(assemblyInput(loaded, true));
          rows = loaded;
          filtered = result;
          return result;
        },
        collector,
        { candidatesIn: candidates.length, candidatesOut: (value) => value.relevantChunks.length },
      );

      const assembled = await runStage(
        spec('assemble', 'skip'),
        signal,
        async (stageSignal) => {
          const loaded: AssemblyRows = rows ?? (await loadRows(candidates, stageSignal));
          const applyRelevanceFilter = !postFilter.skipped;
          const state = filtered ?? filterCandidates(assemblyInput(loaded, applyRelevanceFilter));
          return buildContext(state, assemblyInput(loaded, applyRelevanceFilter));
        },
        collector,
        {
          candidatesIn: postFilter.skipped ? candidates.length : postFilter.value.relevantChunks.length,
          candidatesOut: (value) => value.usedDocuments.length,
        },
      );
      assembly = assembled.skipped ? null : assembled.value;
    }
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', queryContext);
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

  const records = collector.stages();
  const status = assembleDisabledStatus(
    records,
    deriveStatus(records, assembly ? survivorCount(assembly) : candidates.length),
    assembly ? 0 : candidates.length,
  );
  const reason =
    status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? candidates.length === 0
          ? 'no_candidates'
          : 'no_relevant_context'
        : degradedReason(records);

  const base = failure(collector, status, reason, queryContext);
  if (!assembly) return { ...base, candidates };

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
  };
}

const VOICE_SEARCH_MULTIPLIER = 5;
const VOICE_SEARCH_THRESHOLD = 0.15;
const VOICE_DEFAULT_MATCH_COUNT = 5;

function toVoiceChunk(row: RawChunk, scope: NonNullable<RunRetrievalInput['scope']>): VoiceChunk {
  // Workspace rows have always carried an id; single-tenant rows have not, and the keyword stage dedupes on id.
  return scope.kind === 'single' ? { ...row } : { ...row, id: row.chunk_id };
}

async function runVoicePipeline(input: RunRetrievalInput, collector: TraceCollector): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const scope = input.scope;
  if (scope === null) return failure(collector, 'empty', 'no_tenant', null);

  const { signal, profile, query } = input;
  const config = loadRagConfig(deps.ragEnv());
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, input.stageOverrides);
  const matchCount = validResultCount(input.options?.maxResults) ?? VOICE_DEFAULT_MATCH_COUNT;
  const requireAdmin = () => {
    const admin = deps.adminClient();
    if (!admin) throw new Error('[RAG Voice] admin client unavailable');
    return admin;
  };

  let voice: VoiceResults = { results: [], source_images: [] };
  let voiceInput = 0;

  try {
    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => deps.embedder(query, { signal: stageSignal }), collector),
      'embed',
    );

    const searched = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        async (stageSignal) => {
          const rows = await vectorSearch(scope, embedding, matchCount * VOICE_SEARCH_MULTIPLIER, VOICE_SEARCH_THRESHOLD, {
            client: requireAdmin() as unknown as RpcClient,
            signal: stageSignal,
          });
          return rows.map((row) => toVoiceChunk(row, scope));
        },
        collector,
        { candidatesOut: (value) => value.length },
      ),
      'search',
    );

    const expanded = await runStage(
      spec('voice_keyword_fallback', 'skip'),
      signal,
      (stageSignal) => voiceKeywordFallback({ query, scope, admin: requireAdmin(), signal: stageSignal, existing: searched }),
      collector,
      { candidatesIn: searched.length, candidatesOut: (value) => value.length },
    );
    const merged = expanded.skipped ? searched : expanded.value;

    const reranked = await runStage(
      spec('local_rerank', 'skip'),
      signal,
      () => hybridRerank(query, enrichVoiceCandidates(merged), { topK: matchCount, includeScores: true }),
      collector,
      { candidatesIn: merged.length, candidatesOut: (value) => value.length },
    );
    const ranked = reranked.skipped ? enrichVoiceCandidates(merged) : reranked.value;

    const assembled = await runStage(
      spec('assemble', 'skip'),
      signal,
      () => assembleVoiceResults({ query, chunks: ranked, matchCount }),
      collector,
      { candidatesIn: ranked.length, candidatesOut: (value) => value.results.length },
    );
    voiceInput = ranked.length;
    voice = assembled.skipped ? { results: [], source_images: [] } : assembled.value;
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', null);
      if (error.original instanceof RetrievalBackendError) {
        logger.error('RAG Pipeline', 'Backend error', { rpc: error.original.rpc, code: error.original.code });
        return failure(collector, 'error', 'backend_error', null);
      }
      logger.error('RAG Pipeline', 'Stage failure', { stage: error.stage, reason: error.reason });
      return failure(collector, 'error', `${error.stage}_${error.reason}`, null);
    }
    if (signal.aborted) return failure(collector, 'error', 'aborted', null);
    logger.error('RAG Pipeline', 'Voice pipeline failure', { name: error instanceof Error ? error.name : 'unknown' });
    return failure(collector, 'error', 'voice_pipeline_failed', null);
  }

  const records = collector.stages();
  const status = assembleDisabledStatus(records, deriveStatus(records, voice.results.length), voiceInput);
  const reason = status === 'ok' ? 'ok' : status === 'empty' ? 'no_candidates' : degradedReason(records);
  return { ...failure(collector, status, reason, null), voice };
}
