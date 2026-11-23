import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { RetrievalBackendError } from './backend/supabase-rpc';
import {
  CORE_STAGES,
  FALLBACK_STAGE_TIMEOUT_MS,
  loadRagConfig,
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
import { getRagDeps } from './deps';
import { legacyAnalyze, legacyRank, legacySearch } from './legacy/enhanced-retrieval';
import { defaultQueryContext } from './query/temporal-query-detector';
import { assertTenantScope, scopeKey } from './tenant/scope';
import { createTraceCollector, type TraceCollector } from './trace/collector';
import { finishTrace } from './trace/finish';
import type {
  Candidate,
  Profile,
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

function degradedReason(records: StageRecord[]): string {
  const skipped = records.find((record) => record.status === 'skipped');
  return skipped ? `${skipped.name}_${skipped.reason ?? 'skipped'}` : 'degraded';
}

export async function runRetrieval(input: RunRetrievalInput): Promise<RetrievalResult> {
  if (input.scope !== null) assertTenantScope(input.scope);

  const ownsTrace = input.trace === undefined;
  const collector =
    input.trace ??
    createTraceCollector({ profile: input.profile, tenantKey: input.scope ? scopeKey(input.scope) : 'none' });

  const result = await runPipeline(input, collector);
  if (ownsTrace) finishTrace(collector, result);
  return result;
}

async function runPipeline(input: RunRetrievalInput, collector: TraceCollector): Promise<RetrievalResult> {
  const deps = getRagDeps();
  const scope = input.scope;

  if (scope === null) {
    return failure(collector, 'empty', 'no_tenant', null);
  }

  const { signal, profile } = input;
  const config = loadRagConfig(deps.ragEnv());
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, input.stageOverrides);

  const maxResults = input.options?.maxResults ?? parseInt(env.RAG_FINAL_RESULT_COUNT || '25');
  const fallbackToLowerThreshold = input.options?.fallbackToLowerThreshold ?? true;

  let queryContext: RetrievalResult['queryContext'] = null;
  let candidates: Candidate[] = [];
  let assembly: AssembleOutput<Candidate> | null = null;

  try {
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
            client: deps.anonClient(),
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

    if ((ASSEMBLY_PROFILES as readonly string[]).includes(profile)) {
      const assemblyInput = (rows: AssemblyRows, applyRelevanceFilter: boolean): AssembleInput<Candidate> => ({
        queryText: input.query,
        candidates,
        documents: rows.documents,
        chunkMetadata: rows.chunkMetadata,
        referenced: input.options?.referenced ?? null,
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
  const status = deriveStatus(records, assembly ? survivorCount(assembly) : candidates.length);
  const reason =
    status === 'ok' ? 'ok' : status === 'empty' ? (candidates.length === 0 ? 'no_candidates' : 'no_relevant_context') : degradedReason(records);

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
