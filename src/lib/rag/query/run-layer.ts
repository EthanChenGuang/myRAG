import { QueryTranslationSchema, type QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { logger } from '@/lib/logger';
import type { QueryLayerConfig, QueryTransformSwitches, RagConfig, StageName } from '../config';
import { getRagDeps } from '../deps';
import { runStage, stageSpec, StageError, type StageSpec } from '../pipeline';
import type { TenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { HistoryTurn, Profile, QueryLayerOverrides, QueryVariant, RunRetrievalInput, StageOverrides } from '../types';
import { normalizeRelativeDates, type NormalizedDates, type RelativeDateRange } from './dates';
import { groupDeadlineMs, groupDeadlineSignal, transformAbortReason, transformSignal } from './deadline';
import type { NativeTransformSkip } from './llamaindex/call';
import type { PostCheckLimits, PostCheckSkip, PostCheckSkipReason } from './post-checks';
import { getKbLanguageShares, translationTargets, type KbLanguageShares } from './kb-languages';
import type { TranslateSkip } from './llamaindex/translate';
import { buildQueryPlan, planToVariants, type SkippedTransform } from './plan';
import { effectiveQueryParams } from './query-params';
import { needsRewrite, type GateResult, type Lang } from './rewrite-gate';
import { routeTransforms, type RoutedTransform, type RoutedTransforms } from './router';
import { getQueryTransformer, type CondenseResult, type DecomposeResult, type ExpandResult, type HydeResult, type QueryTransformer } from './transformer';
import { queryLayerTranslator, type QueryLayerTranslateContext } from './translate';
import type { TranslatedQuery } from './variants';
import { getActiveProfile, LEGACY_PROFILE } from '../embeddings/active-profile';
import { effectiveQueryLayerConfig, queryLayerOverrides } from './layer-config';

export { effectiveQueryLayerConfig, queryLayerOverrides } from './layer-config';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import { env } from '@/lib/env';
import { checkBypassReason, type CacheRetrievalOptions, type TurnFacts } from '../cache/bypass';
import { resolveHitSources } from '../cache/sources';
import type { CacheHit, CacheKeyParts, CacheTicket, EntryProfile } from '../cache/types';
import { resolveFinalResultCount } from '../config';
import type { RpcClient } from '../backend/supabase-rpc';

export type QueryLayerShortCircuit = { kind: 'small_talk' } | { kind: 'cache_hit' };

/** D-11: everything the query layer hands to the retrieval stages. It never carries a scope, a mode or tools. */
export interface QueryLayerOutcome {
  plan: QueryPlan | null;
  /** Plan order: the original first, then the rewrites. */
  variants: QueryVariant[];
  /** A relative-date range to narrow the filters with (never to widen them). */
  dateRange: RelativeDateRange | null;
  /** True when the layer served translation itself, so the Phase 4 translate stage stands down. */
  handledTranslate: boolean;
  shortCircuit: QueryLayerShortCircuit | null;
  /** Set with shortCircuit cache_hit: the cached answer, citations re-resolved against the current sources. */
  cacheHit?: CacheHit;
  /** Set when the semantic_cache stage checked with no check-time bypass (D-32, A-3). */
  cacheTicket?: CacheTicket;
  /** The standalone query's embedding from the cache stage; the embed stage reuses it instead of embedding the text again. */
  precomputed?: { text: string; embedding: QueryEmbedding };
}

/** What the pipeline lends the semantic_cache stage, so its key and vector equal what the retrieval stages use. */
export interface SemanticCacheSeam {
  /** Embeds one text exactly as the embed stage would (eval embedding profile included). */
  embed(text: string, signal: AbortSignal): Promise<QueryEmbedding>;
  /** The request's retrieval-config hash for this embedding, query-layer part included. */
  retrievalConfigHash(embedding: QueryEmbedding): Promise<string>;
}

export interface QueryLayerInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
  /** The request's minted scope: the only tenant input for the KB language shares (D-23) and the semantic cache. */
  scope?: TenantScope;
  /** Absent: the semantic_cache stage stands down. */
  cache?: SemanticCacheSeam;
}

const NO_LAYER_OUTCOME: Readonly<QueryLayerOutcome> = Object.freeze({
  plan: null,
  variants: [],
  dateRange: null,
  handledTranslate: false,
  shortCircuit: null,
});

type PlanTransform = SkippedTransform['transform'];
type TransformStage = Exclude<RoutedTransform, 'translate'>;

const PLAN_NAME: Readonly<Record<TransformStage, PlanTransform>> = {
  condense: 'condense_history',
  normalize_dates: 'normalize_dates',
  expand: 'expand',
  hyde: 'hyde',
  decompose: 'decompose',
};

const SWITCH: Readonly<Record<TransformStage, keyof QueryTransformSwitches>> = {
  condense: 'condense',
  normalize_dates: 'normalizeDates',
  expand: 'expand',
  hyde: 'hyde',
  decompose: 'decompose',
};

function usableHistory(history: readonly HistoryTurn[] | undefined): HistoryTurn[] {
  if (!history) return [];
  return history.filter(
    (turn) => (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string' && turn.content.trim().length > 0,
  );
}

function postCheckReason(reason: PostCheckSkipReason): SkippedTransform['reason'] {
  if (reason === 'empty') return 'error';
  return reason;
}

function gateDetail(gate: GateResult): string {
  return `lang=${gate.lang} transforms=${gate.transforms.length > 0 ? gate.transforms.join(',') : 'none'}`;
}

class TransformCallFailed extends Error {
  constructor(stage: string) {
    super(`[Query Layer] ${stage} call failed`);
    this.name = 'TransformCallFailed';
  }
}

function raceSignal<T>(signal: AbortSignal, fn: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
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

type TransformOutcome<T> = { ran: true; value: T } | { ran: false; reason: 'disabled' | 'timeout' | 'failed' };

interface TransformRun<T> {
  spec: StageSpec;
  request: AbortSignal;
  /** The parallel group's deadline signal; null outside the group and for voice and eval. */
  group: AbortSignal | null;
  collector: TraceCollector;
  /** A result that reports a failed model call: the stage is recorded skipped, not ok. */
  failed?: (value: T) => boolean;
  detail?: (value: T) => string | undefined;
}

/**
 * One query-layer transform as its own stage (D-27/D-28), with the Phase 2 runner's record semantics. Its signal combines
 * the request, the group deadline and the stage timeout, so a group or stage deadline is a timeout and a request abort is
 * aborted (and rethrown). Timers come from deadline.ts, so fake timers control them.
 */
async function runTransform<T>(run: TransformRun<T>, fn: (signal: AbortSignal) => Promise<T> | T): Promise<TransformOutcome<T>> {
  const { spec, request, group, collector } = run;
  if (request.aborted) throw new StageError(spec.name, 'aborted', request.reason);
  if (!spec.enabled) {
    const at = collector.now();
    collector.record({ name: spec.name, status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at });
    return { ran: false, reason: 'disabled' };
  }

  const signal = transformSignal(request, group, spec.timeoutMs);
  const startedAt = collector.now();
  try {
    const value = await raceSignal(signal, fn);
    signal.throwIfAborted();
    if (run.failed?.(value)) throw new TransformCallFailed(spec.name);
    collector.record({
      name: spec.name,
      status: 'ok',
      startedAt,
      endedAt: collector.now(),
      detail: run.detail ? run.detail(value) : undefined,
    });
    return { ran: true, value };
  } catch (error) {
    const reason = transformAbortReason(request, signal) ?? 'failed';
    const endedAt = collector.now();
    if (reason === 'aborted') {
      collector.record({ name: spec.name, status: 'aborted', reason, startedAt, endedAt });
      throw new StageError(spec.name, reason, error);
    }
    collector.record({ name: spec.name, status: 'skipped', reason, startedAt, endedAt });
    logger.warn('RAG Pipeline', 'Optional stage skipped', { stage: spec.name, reason });
    return { ran: false, reason };
  }
}

function callFailed(skipped: ReadonlyArray<PostCheckSkip | NativeTransformSkip>): boolean {
  return skipped.some((entry) => 'transform' in entry);
}

function isPostCheckSkip(entry: PostCheckSkip | NativeTransformSkip): entry is PostCheckSkip {
  return 'kind' in entry;
}

function rangeContract(dates: NormalizedDates): QueryPlan['date_range'] {
  if (!dates.range) return null;
  return { from_date: dates.range.from, to_date: dates.range.to, include_undated: true, time_zone: dates.range.timeZone };
}

/** The D-08 LLM-variant budget left for expansion: condensed and HyDE variants are counted first, the original never. */
export function expandAllowance(budget: number, condensed: boolean, hyde: boolean): number {
  return Math.max(0, budget - (condensed ? 1 : 0) - (hyde ? 1 : 0));
}

/** The embedding profile the request searches with (D-24 per-profile switch): the eval option, else the active profile. */
async function requestEmbeddingProfileId(input: RunRetrievalInput, profile: Profile): Promise<string> {
  const evalProfile = profile === 'eval' ? input.options?.embeddingProfile : undefined;
  if (evalProfile) return evalProfile;
  try {
    return (await getActiveProfile()).id;
  } catch {
    return '';
  }
}

/** D-24: the layer owns translation when its switch is on, the stage is not operator- or request-disabled, and voice allows it. */
function layerTranslates(layer: QueryLayerConfig, config: RagConfig, profile: Profile, requestDisabled: ReadonlySet<string>): boolean {
  if (!layer.enabled || !layer.transforms.translate || config.monolingual) return false;
  if (config.operatorDisabledStages?.has('translate') || requestDisabled.has('translate')) return false;
  if (profile === 'voice' && !layer.voiceTransforms.includes('translate')) return false;
  return true;
}

const PLAN_LANGUAGES: readonly string[] = QueryTranslationSchema.shape.target_language.options;

function isPlanLanguage(language: string): language is Lang {
  return PLAN_LANGUAGES.includes(language);
}

function translateSkipReason(reason: TranslateSkip['reason']): SkippedTransform['reason'] {
  if (reason === 'protected_token_lost' || reason === 'length' || reason === 'cap') return reason;
  if (reason === 'aborted') return 'timeout';
  return 'error';
}

const ENTRY_PROFILES: Readonly<Partial<Record<Profile, EntryProfile>>> = { chat: 'chat', embed: 'embed', eval: 'eval' };

/** D-38: an eval request runs the cache only when it asks for it; the environment still has to enable a backend. */
function evalCacheOverride(overrides: QueryLayerOverrides | undefined): boolean {
  return overrides?.semanticCache !== undefined && overrides.semanticCache !== 'off';
}

function cacheRetrievalOptions(input: RunRetrievalInput): CacheRetrievalOptions | undefined {
  const options = input.options;
  if (!options) return undefined;
  const picked: CacheRetrievalOptions = {};
  if (options.mediaKind !== undefined) picked.mediaKind = options.mediaKind;
  if (options.generalOverview !== undefined) picked.generalOverview = options.generalOverview;
  if (options.maxResults !== undefined) picked.maxResults = options.maxResults;
  if (options.degrade !== undefined) picked.degrade = options.degrade;
  if (options.embeddingBindings !== undefined) picked.embeddingBindings = options.embeddingBindings;
  if (options.domainControlLeg !== undefined) picked.domainControlLeg = options.domainControlLeg;
  return picked;
}

interface CacheStageInput {
  ctx: QueryLayerInput;
  layerOverrides: QueryLayerOverrides | undefined;
  gate: GateResult;
  standalone: string;
  historyLength: number;
  condenseOk: boolean;
  framework: CacheKeyParts['queryFramework'];
  spec: StageSpec;
  embedSpec: StageSpec;
}

interface CacheStageResult {
  hit?: CacheHit;
  ticket?: CacheTicket;
  precomputed?: { text: string; embedding: QueryEmbedding };
}

type CacheLookup = { kind: 'hit'; hit: CacheHit } | { kind: 'miss' } | { kind: 'unresolved' };

function lookupDetail(lookup: CacheLookup): string {
  if (lookup.kind === 'hit') return `hit distance=${lookup.hit.distance.toFixed(4)}`;
  return lookup.kind === 'unresolved' ? 'miss citations_unresolved' : 'miss';
}

/**
 * D-05/D-32/D-33/D-36: the cache lookup after the parallel group. Bypass rules run before anything is embedded or checked;
 * the standalone is embedded once and lent to the embed stage; check and source re-resolution share the 150 ms stage budget
 * and fail open to a miss. The lookup is scoped by the request's TenantScope and the embedding profile, and the entry
 * profile follows input.profile, never caller data.
 */
async function runSemanticCacheStage(args: CacheStageInput): Promise<CacheStageResult> {
  const { ctx, gate, spec } = args;
  const { input, profile, signal, collector } = ctx;
  const record = (status: 'disabled' | 'skipped', detail: string, reason?: 'disabled' | 'failed' | 'timeout') => {
    const at = collector.now();
    collector.record({ name: 'semantic_cache', status, reason: reason ?? (status === 'disabled' ? 'disabled' : 'failed'), startedAt: at, endedAt: at, detail });
  };

  const evalOverride = profile === 'eval' && evalCacheOverride(args.layerOverrides);
  if (!spec.enabled || (profile === 'eval' && !evalOverride)) {
    record('disabled', 'off');
    return {};
  }

  const context = input.cacheContext;
  const facts: TurnFacts = {
    profile,
    evalCacheOverride: evalOverride,
    ragMode: input.options?.ragMode ?? 'bypass',
    gate: { transforms: gate.transforms, reasons: gate.reasons, protectedTokens: gate.protectedTokens, skipRetrieval: gate.skipRetrieval },
    rawQuery: input.query,
    standalone: args.standalone,
    historyLength: args.historyLength,
    condenseOk: args.condenseOk,
    webSearch: context?.webSearch ?? input.options?.webSearchEnabled === true,
    mcpTools: context?.mcpTools ?? false,
    documentRefCount: (input.documentRefs?.mentions.length ?? 0) + (input.documentRefs?.documentParts.length ?? 0),
    retrievalOptions: cacheRetrievalOptions(input),
    defaultMaxResults: resolveFinalResultCount(undefined, env.RAG_FINAL_RESULT_COUNT),
  };
  const bypass = checkBypassReason(facts);
  if (bypass !== null) {
    record('disabled', `bypass=${bypass}`);
    return {};
  }

  const entryProfile = ENTRY_PROFILES[profile];
  const scope = ctx.scope;
  const cache = getRagDeps().semanticCache();
  if (!context || !ctx.cache || !scope || !entryProfile) {
    record('disabled', 'no_cache_context');
    return {};
  }
  if (!cache) {
    record('disabled', 'no_backend');
    return {};
  }

  let embedding: QueryEmbedding;
  let retrievalConfigHash: string;
  try {
    embedding = await ctx.cache.embed(args.standalone, transformSignal(signal, null, args.embedSpec.timeoutMs));
    retrievalConfigHash = await ctx.cache.retrievalConfigHash(embedding);
  } catch (error) {
    if (signal.aborted) throw new StageError('semantic_cache', 'aborted', error);
    record('skipped', 'key_unavailable');
    logger.warn('RAG Pipeline', 'Optional stage skipped', { stage: 'semantic_cache', reason: 'key_unavailable' });
    return {};
  }
  const precomputed = { text: args.standalone, embedding };

  const key: CacheKeyParts = {
    answerLanguage: gate.lang,
    ragMode: facts.ragMode as CacheKeyParts['ragMode'],
    generatorModel: context.generatorModel,
    retrievalConfigHash,
    queryFramework: args.framework,
    entryProfile,
    systemPromptHash: context.systemPromptHash,
  };
  const embeddingProfileId = embedding.profile?.id ?? LEGACY_PROFILE.id;
  const ticket: CacheTicket = { key, embeddingProfileId, standalone: args.standalone, vector: embedding.vector, turn: facts };

  const looked = await runStage<CacheLookup>(
    spec,
    signal,
    async (stageSignal) => {
      const hit = await cache.check({ ...key, scope, standalone: args.standalone, vector: embedding.vector, embeddingProfileId, signal: stageSignal });
      if (!hit) return { kind: 'miss' };
      const client = getRagDeps().adminClient() as unknown as RpcClient | null;
      return resolveHitSources(scope, hit, { client, signal: stageSignal });
    },
    collector,
    { detail: lookupDetail },
  );
  if (!looked.skipped && looked.value.kind === 'hit') return { hit: looked.value.hit, ticket, precomputed };
  return { ticket, precomputed };
}

export async function runQueryLayer(ctx: QueryLayerInput): Promise<QueryLayerOutcome> {
  const { input, config, profile, signal, collector, stageOverrides } = ctx;
  const deps = getRagDeps();
  const overrides = queryLayerOverrides(profile, stageOverrides);
  const layer = effectiveQueryLayerConfig(config.queryLayer, overrides);
  const params = effectiveQueryParams(profile, overrides?.queryParams);
  const limits: PostCheckLimits = {
    variantMaxChars: params.variant_max_chars,
    variantMaxRatio: params.variant_max_ratio,
    maxSubQuestions: params.max_sub_questions,
  };
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const requestDisabled = new Set<string>(profile === 'eval' ? (stageOverrides?.disabledStages ?? []) : []);
  const transformSpec = (name: TransformStage): StageSpec => {
    const base = spec(name, 'skip');
    const override = overrides?.transforms?.[SWITCH[name]];
    if (override === true) return { ...base, enabled: !requestDisabled.has(name) };
    if (override === false) return { ...base, enabled: false };
    return base;
  };
  const history = usableHistory(input.history);

  // A-7: the parallel-group deadline is anchored here, at the gate start (the KB shares are the gate's R8 input).
  const gateStartedAt = deps.now();

  // D-23/D-24: the layer serves translation; the KB shares are read (cached per tenant) only when it may translate.
  const translateSpec: StageSpec = { ...spec('translate', 'skip'), enabled: true };
  const handledTranslate = layerTranslates(layer, config, profile, requestDisabled);
  const embeddingProfileId =
    handledTranslate && layer.translateDisabledProfiles.length > 0 ? await requestEmbeddingProfileId(input, profile) : '';
  const translateForProfile = handledTranslate && !layer.translateDisabledProfiles.includes(embeddingProfileId);
  let kbShares: KbLanguageShares | null = null;
  if (translateForProfile) {
    kbShares = ctx.scope ? await getKbLanguageShares(ctx.scope, { signal: transformSignal(signal, null, translateSpec.timeoutMs) }) : null;
  }

  const gated = await runStage(
    spec('query_gate', 'skip'),
    signal,
    () =>
      needsRewrite(input.query, {
        hasHistory: history.length > 0,
        now: new Date(deps.now()),
        ...(kbShares ? { kbShares } : {}),
      }),
    collector,
    { rules: (value) => [...value.reasons], detail: gateDetail },
  );
  if (gated.skipped) return { ...NO_LAYER_OUTCOME };
  const gate = gated.value;

  const route: RoutedTransforms = routeTransforms({
    gate,
    classification: input.classification ?? null,
    config: layer,
    profile,
    embeddingProfileId,
  });
  const transformer: QueryTransformer = getQueryTransformer(route.framework);
  const skipped: SkippedTransform[] = [];
  const skip = (transform: PlanTransform, reason: SkippedTransform['reason']) => {
    if (!skipped.some((entry) => entry.transform === transform && entry.reason === reason)) skipped.push({ transform, reason });
  };

  if (route.skipRetrieval) {
    const plan = buildQueryPlan({ original: input.query, gate, framework: transformer.framework, skipped });
    return { plan, variants: planToVariants(plan), dateRange: null, handledTranslate, shortCircuit: { kind: 'small_talk' } };
  }
  if (handledTranslate && !translateForProfile) skip('translate', 'disabled_for_profile');
  else if (translateForProfile && kbShares === null) skip('translate', 'error');

  // Router decisions are configuration: recorded disabled, never degraded (D-28). The translate record is the Phase 4 slot's.
  for (const entry of route.skipped) {
    if (entry.transform === 'translate') continue;
    const at = collector.now();
    collector.record({ name: entry.transform, status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at, detail: entry.reason });
  }
  const routed = new Set(route.transforms);

  let condensed: string | null = null;
  let condenseOk = false;
  if (routed.has('condense')) {
    const outcome = await runTransform<CondenseResult>(
      {
        spec: transformSpec('condense'),
        request: signal,
        group: null,
        collector,
        detail: (value) => (value.skip ? `discarded=${value.skip.reason}` : value.passThrough ? 'pass_through' : undefined),
      },
      (stageSignal) =>
        transformer.condense({ query: input.query, history, language: gate.lang, protectedTokens: gate.protectedTokens, limits, signal: stageSignal }),
    );
    if (outcome.ran) {
      if (outcome.value.skip) {
        skip('condense_history', postCheckReason(outcome.value.skip.reason));
        console.warn('[Query Layer] condense output discarded', { reason: outcome.value.skip.reason });
      } else {
        condenseOk = true;
        if (!outcome.value.passThrough) condensed = outcome.value.standalone;
      }
    } else if (outcome.reason !== 'disabled') {
      skip('condense_history', outcome.reason === 'timeout' ? 'timeout' : 'error');
    }
  }
  const standalone = condensed ?? input.query;

  // D-05/D-27: the parallel group on the standalone query, under one deadline (chat and embed only; voice and eval have none).
  const cacheSpec = spec('semantic_cache', 'skip');
  const budgetProfile = profile === 'chat' || profile === 'embed' ? profile : null;
  const deadline = groupDeadlineMs({
    profile,
    elapsedMs: deps.now() - gateStartedAt,
    cacheTimeoutMs: cacheSpec.enabled ? cacheSpec.timeoutMs : 0,
    ...(budgetProfile && params.query_budget_ms ? { queryBudgetMs: params.query_budget_ms[budgetProfile] } : {}),
  });
  const group = groupDeadlineSignal(deadline === null ? null : Math.min(deadline, params.group_deadline_ms));

  const runHyde = routed.has('hyde') && params.max_llm_variants - (condensed ? 1 : 0) >= 1;
  if (routed.has('hyde') && !runHyde) skip('hyde', 'cap');
  const expandItems = expandAllowance(params.max_llm_variants, condensed !== null, runHyde);
  const runExpand = routed.has('expand') && expandItems > 0;
  if (routed.has('expand') && !runExpand) skip('expand', 'cap');

  const transformRun = <T>(name: TransformStage, extra: Pick<TransformRun<T>, 'failed' | 'detail'> = {}): TransformRun<T> => ({
    spec: transformSpec(name),
    request: signal,
    group,
    collector,
    ...extra,
  });
  const base = { query: standalone, language: gate.lang, protectedTokens: gate.protectedTokens, limits };

  const translateSkips: TranslateSkip[] = [];
  const runTranslate = handledTranslate && routed.has('translate');
  const translateTargets: Lang[] = runTranslate ? translationTargets(gate.lang, kbShares) : [];

  const tasks: [
    Promise<TransformOutcome<NormalizedDates>> | null,
    Promise<TransformOutcome<ExpandResult>> | null,
    Promise<TransformOutcome<HydeResult>> | null,
    Promise<TransformOutcome<DecomposeResult>> | null,
    Promise<TransformOutcome<TranslatedQuery[]>> | null,
  ] = [
    routed.has('normalize_dates')
      ? runTransform(transformRun<NormalizedDates>('normalize_dates', { detail: (value) => (value.range ? `range=${value.range.from}..${value.range.to} tz=${value.timeZone}` : 'no_range') }), () => {
          const dates = normalizeRelativeDates(standalone, { now: new Date(deps.now()), timeZone: input.timeZone });
          return dates.range || standalone === input.query ? dates : normalizeRelativeDates(input.query, { now: new Date(deps.now()), timeZone: input.timeZone });
        })
      : null,
    runExpand
      ? runTransform(transformRun<ExpandResult>('expand', { failed: (value) => callFailed(value.skipped) }), (stageSignal) =>
          transformer.expand({ ...base, maxItems: expandItems, signal: stageSignal }),
        )
      : null,
    runHyde
      ? runTransform(transformRun<HydeResult>('hyde', { failed: (value) => callFailed(value.skipped) }), (stageSignal) =>
          transformer.hyde({ ...base, signal: stageSignal }),
        )
      : null,
    routed.has('decompose')
      ? runTransform(
          transformRun<DecomposeResult>('decompose', {
            failed: (value) => callFailed(value.skipped),
            detail: (value) => (value.notCompound ? 'not_compound' : undefined),
          }),
          (stageSignal) => transformer.decompose({ ...base, signal: stageSignal }),
        )
      : null,
    runTranslate
      ? runTransform<TranslatedQuery[]>(
          {
            spec: translateSpec,
            request: signal,
            group,
            collector,
            detail: (value) => (translateTargets.length === 0 ? 'no_targets' : `targets=${translateTargets.join(',')} variants=${value.length}`),
          },
          (stageSignal) => {
            const translateCtx: QueryLayerTranslateContext = {
              signal: stageSignal,
              sourceLanguage: gate.lang,
              targets: translateTargets,
              protectedTokens: gate.protectedTokens,
              maxItems: params.max_translations,
              limits,
              transformer,
              onSkip: (entry) => translateSkips.push(entry),
            };
            return queryLayerTranslator.translate(standalone, translateCtx);
          },
        )
      : null,
  ];
  const settled = await Promise.allSettled(tasks.map((task) => task ?? Promise.resolve(null)));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  const [dates, expand, hyde, decompose, translation] = settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as [
    TransformOutcome<NormalizedDates> | null,
    TransformOutcome<ExpandResult> | null,
    TransformOutcome<HydeResult> | null,
    TransformOutcome<DecomposeResult> | null,
    TransformOutcome<TranslatedQuery[]> | null,
  ];

  const recordOutcome = <T extends { skipped: ReadonlyArray<PostCheckSkip | NativeTransformSkip> }>(
    name: TransformStage,
    outcome: TransformOutcome<T> | null,
  ): T | null => {
    if (!outcome) return null;
    if (!outcome.ran) {
      if (outcome.reason !== 'disabled') skip(PLAN_NAME[name], outcome.reason === 'timeout' ? 'timeout' : 'error');
      return null;
    }
    for (const entry of outcome.value.skipped) if (isPostCheckSkip(entry)) skip(PLAN_NAME[name], postCheckReason(entry.reason));
    return outcome.value;
  };

  if (dates && !dates.ran && dates.reason !== 'disabled') skip('normalize_dates', dates.reason === 'timeout' ? 'timeout' : 'error');
  const normalized = dates?.ran ? dates.value : null;
  const expanded = recordOutcome('expand', expand);
  const hypothetical = recordOutcome('hyde', hyde);
  const subQuestions = recordOutcome('decompose', decompose);
  if (translation && !translation.ran && translation.reason !== 'disabled') skip('translate', translation.reason === 'timeout' ? 'timeout' : 'error');
  if (translation?.ran) for (const entry of translateSkips) skip('translate', translateSkipReason(entry.reason));
  const translated = translation?.ran
    ? translation.value.flatMap((item) => (isPlanLanguage(item.language) ? [{ text: item.text, language: item.language }] : []))
    : [];

  const plan = buildQueryPlan({
    original: input.query,
    gate,
    framework: transformer.framework,
    condensed,
    skipped,
    dateRange: normalized ? rangeContract(normalized) : null,
    translated,
    expanded: expanded?.variants.map((variant) => variant.text) ?? [],
    hyde: hypothetical?.variant ? { text: hypothetical.variant.text, protectedOk: hypothetical.variant.protectedOk } : null,
    subQuestions: subQuestions?.variants.map((variant) => variant.text) ?? [],
  });

  const cached = await runSemanticCacheStage({
    ctx,
    layerOverrides: overrides,
    gate,
    standalone,
    historyLength: history.length,
    condenseOk,
    framework: transformer.framework,
    spec: cacheSpec,
    embedSpec: spec('embed', 'throw'),
  });
  return {
    plan,
    variants: planToVariants(plan),
    dateRange: normalized?.range ?? null,
    handledTranslate,
    shortCircuit: cached.hit ? { kind: 'cache_hit' } : null,
    ...(cached.hit ? { cacheHit: cached.hit } : {}),
    ...(cached.ticket ? { cacheTicket: cached.ticket } : {}),
    ...(cached.precomputed ? { precomputed: cached.precomputed } : {}),
  };
}
