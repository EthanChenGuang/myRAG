import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { RetrievalBackendError, searchByEmbedding, type RawChunk, type RpcClient } from './backend/supabase-rpc';
import {
  CORE_STAGES,
  FALLBACK_STAGE_TIMEOUT_MS,
  loadRagConfig,
  resolveFinalResultCount,
  validResultCount,
  warnInjectionCheckDisabled,
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
import type { AssemblyDocumentRow } from './context/assemble';
import { assembleVoiceResults, enrichVoiceCandidates, voiceContext, type VoiceResults } from './context/voice';
import { getRagDeps, type RagDeps } from './deps';
import { getEmbeddingProfileById } from './embeddings/active-profile';
import { classifyProfileFailure, embedQuery, embedQueryForEvalProfile, withStaleProfileRetry } from './embeddings/query-embedding';
import { legacyAnalyze, legacyRank, legacySearch, scaleThreshold, searchThresholdsFor } from './legacy/enhanced-retrieval';
import { defaultQueryContext } from './query/temporal-query-detector';
import { renderReferencedSection, resolveDocumentRefs } from './refs/resolve';
import type { SecurityConfig } from './security/config';
import {
  INJECTION_STAGE_GUARD_MS,
  afterRules,
  applyInjectionAction,
  injectionDetectorsFor,
  injectionItems,
  injectionVersions,
  releasedRulesFromRows,
  logInjectionSummary,
  runInjectionCheck,
  runInjectionDetectors,
  type ActiveInjectionMode,
  type InjectionDetectorsRun,
  type InjectionVerdicts,
  type InjectionApplied,
  type InjectionCheckItem,
  type InjectionMarks,
  type ItemCandidate,
  type ReleasedRules,
} from './security/injection-check';
import { exactIdStage, mergeExactCandidates } from './retrieval/exact-id';
import { hybridRerank } from './rerank/local-hybrid';
import { assertTenantScope, scopeKey, type TenantScope } from './tenant/scope';
import { createTraceCollector, sanitizeStageCounts, type TraceCollector } from './trace/collector';
import { finishTrace } from './trace/finish';
import { voiceKeywordFallback, type VoiceChunk } from './voice/keyword-fallback';
import type {
  Candidate,
  InjectionSummary,
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
  counts?: (value: T) => Record<string, number>;
  rules?: (value: T) => string[];
  versions?: (value: T) => string[];
  detail?: (value: T) => string | undefined;
  /** Defaults to ok; injection_check reports degraded when a needed ML detector was unavailable. */
  status?: (value: T) => Extract<StageRecord['status'], 'ok' | 'degraded'>;
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

const PROFILE_FAILURE_REASONS = {
  mismatch: 'embedding_profile_mismatch',
  unavailable: 'embedding_profile_unavailable',
} as const;

/** Embedding-profile failures are retrieval errors, never an empty result: strict chat then says the knowledge base is unavailable. */
function profileFailureReason(original: unknown): string | null {
  const kind = classifyProfileFailure(original);
  return kind ? PROFILE_FAILURE_REASONS[kind] : null;
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
    const counts = options.counts ? sanitizeStageCounts(options.counts(value)) : undefined;
    collector.record({
      name: spec.name,
      status: options.status ? options.status(value) : 'ok',
      startedAt,
      endedAt: collector.now(),
      candidatesIn,
      candidatesOut: options.candidatesOut ? options.candidatesOut(value) : null,
      ...(counts !== undefined ? { counts } : {}),
      ...(options.rules ? { rules: options.rules(value) } : {}),
      ...(options.versions ? { versions: options.versions(value) } : {}),
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

export const INJECTION_DETECTOR_UNAVAILABLE = 'detector_unavailable';

function detectorUnavailable(record: StageRecord): boolean {
  return record.name === 'injection_check' && record.status === 'degraded' && record.detail === INJECTION_DETECTOR_UNAVAILABLE;
}

export function deriveStatus(records: StageRecord[], survivingCount: number): RetrievalResult['status'] {
  if (records.some((record) => record.status === 'error' || record.status === 'timeout' || record.status === 'aborted')) {
    return 'error';
  }
  // A detector outage degrades only a result that would otherwise be ok: with nothing surviving it stays empty.
  if (records.some((record) => record.status === 'skipped' || (record.status === 'degraded' && !detectorUnavailable(record)))) return 'degraded';
  if (survivingCount === 0) return 'empty';
  return records.some(detectorUnavailable) ? 'degraded' : 'ok';
}

export function stageSpec(
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

export function requireValue<T>(outcome: StageOutcome<T>, stage: string): T {
  if (outcome.skipped) throw new StageError(stage, 'failed');
  return outcome.value;
}

export interface InjectionStageInput<C extends ItemCandidate> {
  spec: StageSpec;
  signal: AbortSignal;
  collector: TraceCollector;
  profile: Profile;
  security: SecurityConfig;
  mode: ActiveInjectionMode;
  items: readonly InjectionCheckItem[];
  candidates: readonly C[];
  referenced: ReferencedState | null;
  /** The request's tenant: it keys the ML verdict cache (A-9). Without one no ML detector runs. */
  scope: TenantScope | null;
  /** Released rule ids from document rows already loaded under the caller's scope. */
  released?: ReleasedRules;
}

export interface InjectionStageRun<C extends ItemCandidate> {
  applied: InjectionApplied<C> | null;
  stalled: boolean;
}

function withDetectors<C extends ItemCandidate>(applied: InjectionApplied<C>, run: InjectionDetectorsRun): InjectionApplied<C> {
  if (run.reported.length === 0) return applied;
  const disabled = Object.keys(run.disabled).length > 0 ? { detectorsDisabled: { ...run.disabled } as Record<string, string> } : {};
  const failures = Object.keys(run.failures).length > 0 ? { detectorFailures: { ...run.failures } as Record<string, string> } : {};
  return {
    ...applied,
    counts: { ...applied.counts, ...run.counts },
    summary: { ...applied.summary, detectorsUnavailable: [...run.unavailable], ...disabled, ...failures },
  };
}

/**
 * The injection_check stage shared by every legacy graph and the v2 graph. The rules run synchronously before any await and their
 * result is held outside the stage race, so a stage timeout can never lose it (A-3). The ML detectors then run on the items the rules
 * did not flag, under an inner deadline below the race; a needed detector that failed marks the stage degraded, never skipped.
 */
export async function runInjectionStage<C extends ItemCandidate>(input: InjectionStageInput<C>): Promise<InjectionStageRun<C>> {
  const { spec, items, mode } = input;
  const deps = getRagDeps();
  const versions = injectionVersions(injectionDetectorsFor(input.profile, input.security));
  let held: InjectionApplied<C> | null = null;
  const apply = (verdicts: InjectionVerdicts) =>
    applyInjectionAction({
      candidates: input.candidates,
      referenced: input.referenced,
      items,
      verdicts,
      mode,
      renderSection: renderReferencedSection,
    });
  const checked = await runStage(
    { ...spec, timeoutMs: spec.timeoutMs + INJECTION_STAGE_GUARD_MS },
    input.signal,
    async (stageSignal) => {
      const verdicts = runInjectionCheck({ items, mode, ...(input.released ? { released: input.released } : {}) });
      const rulesApplied = apply(verdicts);
      held = rulesApplied;
      const detectors = await runInjectionDetectors({
        items,
        verdicts,
        profile: input.profile,
        security: input.security,
        scope: input.scope,
        traceId: input.collector.traceId,
        signal: stageSignal,
        budgetMs: spec.timeoutMs,
        lakeraDetector: deps.lakeraDetector,
        promptGuardClassifier: deps.promptGuardClassifier,
      });
      const applied = withDetectors(detectors.verdicts === verdicts ? rulesApplied : apply(detectors.verdicts), detectors);
      held = applied;
      return afterRules(applied);
    },
    input.collector,
    {
      candidatesIn: items.length,
      candidatesOut: (value) => value.counts.checked - value.counts.dropped,
      counts: (value) => value.counts,
      rules: (value) => value.summary.ruleIds,
      versions: () => versions,
      status: (value) => (value.summary.detectorsUnavailable.length > 0 ? 'degraded' : 'ok'),
      detail: (value) => (value.summary.detectorsUnavailable.length > 0 ? INJECTION_DETECTOR_UNAVAILABLE : undefined),
    },
  );
  const applied: InjectionApplied<C> | null = checked.skipped ? held : checked.value;
  const stalled = checked.skipped && applied !== null;
  if (applied) logInjectionSummary(applied.summary, applied.counts, { traceId: input.collector.traceId, stalled });
  return { applied, stalled };
}

export function injectionDropped(summary: InjectionSummary): boolean {
  return summary.droppedChunkIds.length > 0 || summary.droppedReferenceIds.length > 0;
}

/** Everything that would have reached the model was dropped by the check: `empty` wins over `degraded` (A-3). */
export function injectionFilteredAll(injection: InjectionSummary | undefined, survivors: number, status: RetrievalResult['status']): boolean {
  if (!injection || status === 'error') return false;
  return injectionDropped(injection) && survivors === 0;
}

export function injectionReason(records: StageRecord[], stalled: boolean): string {
  const reason = degradedReason(records);
  return stalled && reason === 'injection_check_timeout' ? 'injection_check_stalled' : reason;
}

/** Downweight for graphs without a renderer that marks: flagged items move after the unflagged ones, order kept. */
export function downweightOrder<C extends { chunk_id: string }>(candidates: readonly C[], flagged: ReadonlySet<string>): C[] {
  return [...candidates.filter((c) => !flagged.has(c.chunk_id)), ...candidates.filter((c) => flagged.has(c.chunk_id))];
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

export function failure(
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

export function assembleDisabledStatus(
  records: StageRecord[],
  status: RetrievalResult['status'],
  reachedAssemble: number,
): RetrievalResult['status'] {
  if (status !== 'ok' && status !== 'empty') return status;
  if (reachedAssemble === 0) return status;
  return records.some((record) => record.name === 'assemble' && record.status === 'disabled') ? 'degraded' : status;
}

export function degradedReason(records: StageRecord[]): string {
  const skipped = records.find((record) => record.status === 'skipped');
  if (skipped) return `${skipped.name}_${skipped.reason ?? 'skipped'}`;
  if (records.some(detectorUnavailable)) return `injection_check_${INJECTION_DETECTOR_UNAVAILABLE}`;
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
  const security = deps.securityConfig();

  let candidates: Candidate[] = [];
  let context = '';
  let injection: InjectionSummary | undefined;
  let injectionStalled = false;

  try {
    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => embedQuery(input.query, stageSignal), collector, {
        detail: (value) => value.profile?.id,
      }),
      'embed',
    );

    let rawChunks = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        (stageSignal) => {
          const adminClient = deps.adminClient();
          if (!adminClient) throw new Error('[RAG Media] admin client unavailable');
          return withStaleProfileRetry(input.query, embedding, stageSignal, (current) =>
            searchByEmbedding(scope, current, MEDIA_MATCH_COUNT, scaleThreshold(searchThresholdsFor(current.profile), MEDIA_SIMILARITY_THRESHOLD), {
              client: adminClient as unknown as RpcClient,
              signal: stageSignal,
            }),
          );
        },
        collector,
        { candidatesOut: (value) => value.length },
      ),
      'search',
    );

    if (security.injectionCheck !== 'off') {
      warnInjectionCheckDisabled(config, security.injectionCheck);
      // Text feeding image and video prompt rewriting is always dropped when flagged, rules only (A-11).
      const run = await runInjectionStage({
        spec: spec('injection_check', 'skip'),
        signal,
        collector,
        scope,
        profile,
        security,
        mode: 'drop',
        items: injectionItems(rawChunks, null, null),
        candidates: rawChunks,
        referenced: null,
      });
      injectionStalled = run.stalled;
      if (run.applied) {
        injection = run.applied.summary;
        rawChunks = run.applied.candidates;
      }
    }

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
      const profileReason = profileFailureReason(error.original);
      if (profileReason) return failure(collector, 'error', profileReason, null);
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
  const derived = deriveStatus(records, candidates.length);
  const filteredAll = injectionFilteredAll(injection, candidates.length, derived);
  const status = filteredAll ? 'empty' : derived;
  const reason = filteredAll
    ? 'injection_filtered'
    : status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? 'no_candidates'
        : injectionReason(records, injectionStalled);
  return { ...failure(collector, status, reason, null), candidates, context, ...(injection ? { injection } : {}) };
}

export async function runRefsStage(
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
  if (resolved.skipped) return null;
  const { usedDocuments, context, sections } = resolved.value;
  return { usedDocuments, context, sections };
}

/**
 * The overview document rows, loaded once before the check so the released rule ids come from rows returned under the
 * caller's scope (the ids are the scoped search results); assemble reuses them. A failed read leaves no exemption and
 * assemble reads again, so the check never fails open.
 */
async function loadOverviewDocumentsForCheck(rawChunks: RawChunk[], signal: AbortSignal): Promise<Map<string, AssemblyDocumentRow> | null> {
  const admin = getRagDeps().adminClient();
  if (!admin || rawChunks.length === 0) return null;
  try {
    return await fetchOverviewDocuments(rawChunks, { admin, signal });
  } catch {
    signal.throwIfAborted();
    return null;
  }
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

  const security = deps.securityConfig();
  let rawChunks: RawChunk[] = [];
  let overview: OverviewContext = { context: '', usedDocuments: [] };
  let injection: InjectionSummary | undefined;
  let injectionStalled = false;

  try {
    let referenced = await runRefsStage(input, scope, spec('refs', 'skip'), collector);

    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => embedQuery(OVERVIEW_QUERY, stageSignal), collector, {
        detail: (value) => value.profile?.id,
      }),
      'embed',
    );

    rawChunks = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        (stageSignal) => {
          const adminClient = deps.adminClient();
          if (!adminClient) throw new Error('[RAG Overview] admin client unavailable');
          return withStaleProfileRetry(OVERVIEW_QUERY, embedding, stageSignal, (current) =>
            searchByEmbedding(scope, current, OVERVIEW_MATCH_COUNT, scaleThreshold(searchThresholdsFor(current.profile), OVERVIEW_SIMILARITY_THRESHOLD), {
              client: adminClient as unknown as RpcClient,
              signal: stageSignal,
            }),
          );
        },
        collector,
        { candidatesOut: (value) => value.length },
      ),
      'search',
    );

    let flaggedForRender: ReadonlySet<string> | undefined;
    let documentRows: Map<string, AssemblyDocumentRow> | null = null;
    if (security.injectionCheck !== 'off') {
      const mode = security.injectionCheck;
      warnInjectionCheckDisabled(config, mode);
      documentRows = await loadOverviewDocumentsForCheck(rawChunks, signal);
      const run = await runInjectionStage({
        spec: spec('injection_check', 'skip'),
        signal,
        collector,
        scope,
        profile,
        security,
        mode,
        items: injectionItems(rawChunks, null, referenced),
        candidates: rawChunks,
        referenced,
        released: releasedRulesFromRows(documentRows),
      });
      injectionStalled = run.stalled;
      if (run.applied) {
        injection = run.applied.summary;
        if (injectionDropped(run.applied.summary)) {
          rawChunks = run.applied.candidates;
          referenced = run.applied.referenced;
        }
        if (run.applied.marks) flaggedForRender = run.applied.marks.chunkIds;
      }
    }

    const assembled = await runStage(
      spec('assemble', 'skip'),
      signal,
      async (stageSignal) => {
        const adminClient = deps.adminClient();
        if (!adminClient) throw new Error('[RAG Overview] admin client unavailable');
        const documents = documentRows ?? (await fetchOverviewDocuments(rawChunks, { admin: adminClient, signal: stageSignal }));
        return assembleOverviewContext(rawChunks, documents, referenced?.usedDocuments ?? [], {
          ...(security.contextTagging ? { contextTagging: true } : {}),
          ...(flaggedForRender ? { flaggedChunkIds: flaggedForRender } : {}),
        });
      },
      collector,
      { candidatesIn: rawChunks.length, candidatesOut: (value) => value.usedDocuments.length },
    );
    overview = assembled.skipped ? { context: '', usedDocuments: referenced?.usedDocuments ?? [] } : assembled.value;
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', null);
      const profileReason = profileFailureReason(error.original);
      if (profileReason) return failure(collector, 'error', profileReason, null);
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
  const derived = assembleDisabledStatus(records, deriveStatus(records, survivors), survivors);
  const filteredAll = injectionFilteredAll(injection, survivors, derived);
  const status = filteredAll ? 'empty' : derived;
  const reason = filteredAll
    ? 'injection_filtered'
    : status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? 'no_candidates'
        : injectionReason(records, injectionStalled);
  return {
    ...failure(collector, status, reason, null),
    candidates,
    context: overview.context,
    usedDocuments: overview.usedDocuments,
    ...(injection ? { injection } : {}),
  };
}

function evalEmbeddingProfileId(input: RunRetrievalInput): string | undefined {
  return input.profile === 'eval' ? input.options?.embeddingProfile : undefined;
}

async function embedForRetrieval(input: RunRetrievalInput, signal: AbortSignal) {
  const profileId = evalEmbeddingProfileId(input);
  if (profileId) return embedQueryForEvalProfile(input.query, signal, await getEmbeddingProfileById(profileId));
  return embedQuery(input.query, signal);
}

export async function runRetrieval(input: RunRetrievalInput): Promise<RetrievalResult> {
  if (input.scope !== null) assertTenantScope(input.scope);

  const ownsTrace = input.trace === undefined;
  const collector =
    input.trace ??
    createTraceCollector({ profile: input.profile, tenantKey: input.scope ? scopeKey(input.scope) : 'none' });

  const deps = getRagDeps();
  const config = loadRagConfig(deps.ragEnv());
  const useV2 =
    config.pipeline === 'v2' &&
    !input.options?.generalOverview &&
    input.profile !== 'media' &&
    (['chat', 'embed', 'eval', 'voice'] as const).includes(input.profile as 'chat' | 'embed' | 'eval' | 'voice');

  const result =
    input.profile === 'voice' && !useV2
      ? await runVoicePipeline(input, collector)
      : useV2
      ? await (await import('./v2/pipeline')).runV2Pipeline(input, collector)
      : await runPipeline(input, collector);
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
  let injection: InjectionSummary | undefined;
  let injectionStalled = false;
  let injectionMarks: InjectionMarks | null = null;
  const security = deps.securityConfig();

  try {
    referenced = await runRefsStage(input, scope, spec('refs', 'skip'), collector);

    const analysis = await runStage(spec('analyze', 'skip'), signal, () => legacyAnalyze(input.query), collector);
    const analysed = analysis.skipped ? defaultQueryContext() : analysis.value;
    queryContext = analysed;

    const evalProfileId = evalEmbeddingProfileId(input);
    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => embedForRetrieval(input, stageSignal), collector, {
        detail: (value) => value.profile?.id,
      }),
      'embed',
    );

    const searched = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        (stageSignal) => {
          const runSearch = (current: typeof embedding) =>
            legacySearch({
              query: input.query,
              embedding: current.vector,
              profile: current.profile,
              queryContext: analysed,
              maxResults,
              fallbackToLowerThreshold,
              scope,
              client: requireAdminSearchClient(deps),
              signal: stageSignal,
              profileRequireActive: evalProfileId ? false : undefined,
            });
          return evalProfileId ? runSearch(embedding) : withStaleProfileRetry(input.query, embedding, stageSignal, runSearch);
        },
        collector,
        { candidatesOut: (value) => value.results.length, detail: (value) => value.retrievalStrategy },
      ),
      'search',
    );

    let rankInput = searched.results;
    if (config.exactIdLookup) {
      const exact = await runStage(
        spec('exact_id_lookup', 'skip'),
        signal,
        (stageSignal) => exactIdStage(input.query, scope, { client: requireAdminSearchClient(deps), signal: stageSignal }),
        collector,
        {
          candidatesIn: searched.results.length,
          candidatesOut: (value) => value.rows.length,
          detail: (value) => `tokens=${value.tokenCount}`,
        },
      );
      if (!exact.skipped && exact.value.rows.length > 0) rankInput = mergeExactCandidates(searched.results, exact.value.rows, maxResults);
    }

    const ranked = await runStage(
      spec('legacy_rank', 'skip'),
      signal,
      () => legacyRank(rankInput, analysed),
      collector,
      { candidatesIn: rankInput.length, candidatesOut: (value) => value.length },
    );
    candidates = ranked.skipped ? rankInput : ranked.value;
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
        citationLabeler: input.citationLabeler,
        ...(security.contextTagging ? { contextTagging: true } : {}),
        ...(injectionMarks ? { injectionMarks } : {}),
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

      if (security.injectionCheck !== 'off') {
        const mode = security.injectionCheck;
        warnInjectionCheckDisabled(config, mode);
        const loadedRows = rows as AssemblyRows | null;
        const current = filtered as FilteredCandidates<Candidate> | null;
        const run = await runInjectionStage({
          spec: spec('injection_check', 'skip'),
          signal,
          collector,
          scope,
          profile,
          security,
          mode,
          items: injectionItems(current ? current.relevantChunks : candidates, loadedRows?.chunkMetadata ?? null, referenced),
          candidates,
          referenced,
          released: releasedRulesFromRows(loadedRows?.documents),
        });
        injectionStalled = run.stalled;
        if (run.applied) {
          injection = run.applied.summary;
          injectionMarks = run.applied.marks;
          if (injectionDropped(run.applied.summary)) {
            candidates = run.applied.candidates;
            referenced = run.applied.referenced;
            if (loadedRows && current) filtered = filterCandidates(assemblyInput(loadedRows, true));
          }
        }
      }

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
          candidatesIn: (filtered as FilteredCandidates<Candidate> | null)?.relevantChunks.length ?? candidates.length,
          candidatesOut: (value) => value.usedDocuments.length,
        },
      );
      assembly = assembled.skipped ? null : assembled.value;
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

  const records = collector.stages();
  const derived = assembleDisabledStatus(
    records,
    deriveStatus(records, assembly ? survivorCount(assembly) : candidates.length),
    assembly ? 0 : candidates.length,
  );
  const injectionFiltered = assembly !== null && injectionFilteredAll(injection, survivorCount(assembly), derived);
  const status = injectionFiltered ? 'empty' : derived;
  const reason = injectionFiltered
    ? 'injection_filtered'
    : status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? candidates.length === 0
          ? 'no_candidates'
          : 'no_relevant_context'
        : injectionReason(records, injectionStalled);

  const base = { ...failure(collector, status, reason, queryContext), ...(injection ? { injection } : {}) };
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
    blocks: assembly.blocks,
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

  const security = deps.securityConfig();
  let voice: VoiceResults = { results: [], source_images: [] };
  let voiceInput = 0;
  let injection: InjectionSummary | undefined;
  let injectionStalled = false;

  try {
    const embedding = requireValue(
      await runStage(spec('embed', 'throw'), signal, (stageSignal) => embedQuery(query, stageSignal), collector, {
        detail: (value) => value.profile?.id,
      }),
      'embed',
    );

    const searched = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        async (stageSignal) => {
          const rows = await withStaleProfileRetry(query, embedding, stageSignal, (current) =>
            searchByEmbedding(
              scope,
              current,
              matchCount * VOICE_SEARCH_MULTIPLIER,
              scaleThreshold(searchThresholdsFor(current.profile), VOICE_SEARCH_THRESHOLD),
              { client: requireAdmin() as unknown as RpcClient, signal: stageSignal },
            ),
          );
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
    let ranked = reranked.skipped ? enrichVoiceCandidates(merged) : reranked.value;
    let flaggedForRender: ReadonlySet<string> | undefined;

    if (security.injectionCheck !== 'off') {
      const mode = security.injectionCheck;
      warnInjectionCheckDisabled(config, mode);
      // The ranked content carries the [Metadata: ...] suffix the voice assembler sends, so the suffix is checked too.
      const run = await runInjectionStage({
        spec: spec('injection_check', 'skip'),
        signal,
        collector,
        scope,
        profile,
        security,
        mode,
        items: injectionItems(ranked, null, null),
        candidates: ranked,
        referenced: null,
      });
      injectionStalled = run.stalled;
      if (run.applied) {
        injection = run.applied.summary;
        if (injectionDropped(run.applied.summary)) ranked = run.applied.candidates;
        if (run.applied.marks) {
          flaggedForRender = run.applied.marks.chunkIds;
          ranked = downweightOrder(ranked, flaggedForRender);
        }
      }
    }

    const assembled = await runStage(
      spec('assemble', 'skip'),
      signal,
      () => assembleVoiceResults({ query, chunks: ranked, matchCount }),
      collector,
      { candidatesIn: ranked.length, candidatesOut: (value) => value.results.length },
    );
    voiceInput = ranked.length;
    voice = assembled.skipped ? { results: [], source_images: [] } : assembled.value;
    if (security.contextTagging && !assembled.skipped) {
      const context = voiceContext(voice.results, flaggedForRender);
      if (context !== null) voice = { ...voice, context };
    }
  } catch (error) {
    if (error instanceof StageError) {
      if (error.reason === 'aborted') return failure(collector, 'error', 'aborted', null);
      const profileReason = profileFailureReason(error.original);
      if (profileReason) return failure(collector, 'error', profileReason, null);
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
  const derived = assembleDisabledStatus(records, deriveStatus(records, voice.results.length), voiceInput);
  const filteredAll = injectionFilteredAll(injection, voice.results.length, derived);
  const status = filteredAll ? 'empty' : derived;
  const reason = filteredAll
    ? 'injection_filtered'
    : status === 'ok'
      ? 'ok'
      : status === 'empty'
        ? 'no_candidates'
        : injectionReason(records, injectionStalled);
  return { ...failure(collector, status, reason, null), voice, ...(injection ? { injection } : {}) };
}
