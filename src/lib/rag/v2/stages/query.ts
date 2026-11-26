import type { RetrievalFilters } from '../../backend/types';
import { terminologyDenseFor, type RagConfig, type StageName } from '../../config';
import { legacyAnalyze } from '../../legacy/enhanced-retrieval';
import { buildRetrievalFilters, effectiveOnFor } from '../../query/filters';
import { getRagDeps } from '../../deps';
import { mergeLayerDateRange } from '../../query/layer-filters';
import { queryLanguage } from '../../query/language';
import { getTranslator, NONE_TRANSLATOR, NONE_TRANSLATOR_NAME } from '../../query/translate';
import { buildQueryVariantSet, PHASE4_VARIANT_LIMITS, queryLayerVariantLimits, textKey, type TranslatedQuery, type VariantLimits } from '../../query/variants';
import { timeframeToDateRange } from '../../query/timeframe';
import { defaultQueryContext, type TemporalQueryContext } from '../../query/temporal-query-detector';
import { runRefsStage, runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, QueryVariantKind, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';
import type { QueryLayerOutcome, SemanticCacheSeam } from '../../query/run-layer';
import type { QueryLanguage } from '../../refusal/gate';
import type { TerminologyMatch } from '@/lib/rag-eval/contracts.generated';
import { expandMatches, substituteCanonicals, terminologyParams } from '../../terminology/expand';
import { terminologyBudget } from '../../terminology/budget';
import { terminologyMatcherFor } from '../../terminology/load';
import { normalizeLexical } from '../../lexical/tokenize';
import { getV2StartupVerdict } from '../startup';
import type { TraceCollector as Collector } from '../../trace/collector';

export interface QueryStagesInput {
  input: RunRetrievalInput;
  scope: TenantScope;
  config: RagConfig;
  profile: Profile;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
  /** Lent to the query layer's semantic_cache stage. */
  cache?: SemanticCacheSeam;
}

export interface QueryStagesOutput {
  referenced: ReferencedState | null;
  queryContext: TemporalQueryContext;
  queryLanguage: QueryLanguage | null;
  filters: RetrievalFilters;
  variants: QueryVariant[];
  /** D-11: the query layer's whole outcome; absent while the layer is off. */
  queryLayer?: QueryLayerOutcome;
  /** D-20: what the terminology stage applied to retrieval; null when it was disabled, skipped or not reached. */
  terminology: TerminologyOutcome | null;
}

/** D-20: the matches and version applied to retrieval, plus the expansion the search group turns into the term:0 list. */
export interface TerminologyOutcome {
  matches: TerminologyMatch[];
  version: string;
  expansionTokens: string[];
  /** D-16: factor on the lexical leg weight in force for the term:0 list. */
  expansionWeight: number;
  capped: boolean;
  /** D-31: whether the term:0 list is searched; false when it has no tokens or the protected variants fill max_searches. */
  termSearch: boolean;
  /** D-18: factor on the dense leg weight in force for the terminology variant's dense list. */
  denseWeight: number;
  /** D-34: rerank-input places term:0-only hits may take; 0 turns the reservation off. */
  reserveSlots: number;
}

function terminologyDetail(value: TerminologyOutcome): string {
  return `matches=${value.matches.length} tokens=${value.expansionTokens.length} capped=${value.capped} version=${value.version}`;
}

function terminologyCounts(value: TerminologyOutcome, versions: { shared: number; workspace: number }): Record<string, number> {
  return {
    matches: value.matches.length,
    tokens: value.expansionTokens.length,
    capped: value.capped ? 1 : 0,
    shared_version: versions.shared,
    workspace_version: versions.workspace,
  };
}

/**
 * D-15: the terminology stage on the standalone query only. A load failure or a timeout records skipped (the request is then
 * degraded by deriveStatus); the detail and counts never carry query, variant or canonical text (D-21).
 */
export async function runTerminologyStage(args: {
  standalone: string;
  scope: TenantScope;
  spec: StageSpec;
  signal: AbortSignal;
  collector: TraceCollector;
}): Promise<TerminologyOutcome | null> {
  const params = terminologyParams();
  const versions = { shared: 0, workspace: 0 };
  const outcome = await runStage(
    args.spec,
    args.signal,
    async (stageSignal): Promise<TerminologyOutcome> => {
      const { dictionary, matcher } = await terminologyMatcherFor(args.scope, { signal: stageSignal, minHanChars: params.min_han_chars });
      versions.shared = dictionary.sharedVersion;
      versions.workspace = dictionary.workspaceVersion;
      const expansion = expandMatches(args.standalone, matcher.match(args.standalone), params);
      return {
        matches: expansion.matches,
        version: dictionary.version,
        expansionTokens: expansion.tokens,
        expansionWeight: params.expansion_weight,
        capped: expansion.capped,
        termSearch: expansion.tokens.length > 0,
        denseWeight: params.dense_weight,
        reserveSlots: params.reserve_slots,
      };
    },
    args.collector,
    { detail: terminologyDetail, counts: (value) => terminologyCounts(value, versions) },
  );
  return outcome.skipped ? null : outcome.value;
}

/** D-18: the standalone query with each matched surface replaced by its canonical; null when nothing changed. */
function terminologyVariant(standalone: string, outcome: TerminologyOutcome, language: string | null): QueryVariant | null {
  if (outcome.matches.length === 0) return null;
  const normalized = normalizeLexical(standalone);
  const text = substituteCanonicals(normalized, outcome.matches).trim();
  if (text === '' || text === normalized.trim()) return null;
  return { text, language, kind: 'terminology', legs: 'dense' };
}

const PROTECTED_KINDS: ReadonlySet<QueryVariantKind> = new Set(['original', 'condensed', 'translated', 'sub_question']);
const MULTI_QUERY_KINDS: ReadonlySet<QueryVariantKind> = new Set(['expanded', 'hyde']);

/** D-31 (3): the cuts are counts on the stage's own record; the record was written before the variant list was final. */
function recordTerminologyCuts(collector: Collector, cuts: { search_cut: 0 | 1; variant_cut: 0 | 1 }): void {
  const record = collector
    .stages()
    .reverse()
    .find((row) => row.name === 'terminology' && row.status === 'ok');
  if (!record) return;
  record.counts = { ...(record.counts ?? {}), ...cuts };
  if (cuts.search_cut === 1 || cuts.variant_cut === 1) record.detail = record.detail ? `${record.detail} cut=cap` : 'cut=cap';
}

/** D-04: the layer runs only when the configuration turned it on (v2 only); an eval request can switch it off, never on. */
function queryLayerActive(config: RagConfig, profile: Profile, overrides: StageOverrides | undefined): boolean {
  if (!config.queryLayer.enabled) return false;
  return !(profile === 'eval' && overrides?.queryLayer?.enabled === false);
}

const HANDLED_BY_QUERY_LAYER = 'handled_by_query_layer';

function analyzeDetail(context: TemporalQueryContext): string | undefined {
  const range = timeframeToDateRange(context.timeframe, new Date());
  if (!range) return undefined;
  return `derived_date_range=${range.from}..${range.to} applied=false`;
}

function referencedDocumentIds(referenced: ReferencedState | null): string[] {
  if (!referenced) return [];
  return referenced.usedDocuments.map((doc) => doc.id);
}

export async function runQueryStages(ctx: QueryStagesInput): Promise<QueryStagesOutput> {
  const { input, scope, config, profile, signal, collector, stageOverrides } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);

  const referenced = await runRefsStage(input, scope, spec('refs', 'skip'), collector);

  const analysis = await runStage(
    spec('analyze', 'skip'),
    signal,
    () => legacyAnalyze(input.query),
    collector,
    { detail: (value) => analyzeDetail(value) },
  );
  const queryContext = analysis.skipped ? defaultQueryContext() : analysis.value;
  const language = queryLanguage(input.query);

  // D-15: after the last query transform and before semantic_cache and embed, on the standalone query only.
  let terminology: TerminologyOutcome | null = null;
  let terminologyRan = false;
  let terminologyStandalone = input.query;
  const terminologyStage = async (standalone: string): Promise<void> => {
    terminologyRan = true;
    terminologyStandalone = standalone;
    terminology = await runTerminologyStage({ standalone, scope, spec: spec('terminology', 'skip'), signal, collector });
  };

  let queryLayer: QueryLayerOutcome | undefined;
  if (queryLayerActive(config, profile, stageOverrides)) {
    const { runQueryLayer } = await import('../../query/run-layer');
    queryLayer = await runQueryLayer({
      input,
      config,
      profile,
      signal,
      collector,
      stageOverrides,
      scope,
      ...(ctx.cache ? { cache: ctx.cache } : {}),
      afterTransforms: terminologyStage,
    });
  }

  let translated: TranslatedQuery[] = [];
  if (queryLayer?.handledTranslate) {
    // The trace keys stages by name: when the layer ran translate itself, its record is the one that stays.
    if (!collector.stages().some((record) => record.name === 'translate')) {
      const at = collector.now();
      collector.record({ name: 'translate', status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at, detail: HANDLED_BY_QUERY_LAYER });
    }
  } else {
    const translator = config.monolingual ? NONE_TRANSLATOR : getTranslator();
    const translation = await runStage(
      spec('translate', 'skip'),
      signal,
      (stageSignal) => translator.translate(input.query, { signal: stageSignal, sourceLanguage: language }),
      collector,
      { detail: () => (translator.name === NONE_TRANSLATOR_NAME ? 'translator_none' : undefined) },
    );
    if (!translation.skipped) translated = translation.value;
  }

  // The layer runs the stage after its parallel group; without the layer (or when it stood down early) it runs here, after translate.
  if (!terminologyRan && queryLayer?.shortCircuit?.kind !== 'small_talk') await terminologyStage(input.query);

  const built = buildRetrievalFilters({
    explicit: input.retrievalFilters,
    referencedDocumentIds: referencedDocumentIds(referenced),
    ...(config.effectiveDates ? { effectiveOn: effectiveOnFor(config, getRagDeps().now()) } : {}),
  });
  const filters = queryLayer?.dateRange ? mergeLayerDateRange(built, queryLayer.dateRange) : built;

  const provided = [...(queryLayer?.variants ?? []), ...(input.queryVariants ?? [])];
  // D-18, D-19: the dense variant needs its switch and never runs in voice. TS narrows `terminology` to null across the closure.
  const term = terminology as TerminologyOutcome | null;
  const termVariant = term && terminologyDenseFor(config, profile) ? terminologyVariant(terminologyStandalone, term, language) : null;
  let termSearch = term ? term.termSearch && config.v2.lexicalSearch && getV2StartupVerdict().icuAvailable : false;
  let searchCut: 0 | 1 = 0;

  // D-08: the layer's max_searches and group limits replace the Phase 4 cap of three; every cut is recorded on the plan.
  let limits: VariantLimits = PHASE4_VARIANT_LIMITS;
  if (queryLayer) {
    const { effectiveQueryParams } = await import('../../query/query-params');
    const queryParams = effectiveQueryParams(profile, profile === 'eval' ? stageOverrides?.queryLayer?.queryParams : undefined);
    limits = queryLayerVariantLimits(queryParams);
    if (term) {
      // D-31: term:0 and the terminology variant count against max_searches and the multi-query limit; protected variants never move.
      const protectedSet = buildQueryVariantSet(
        input.query,
        language,
        translated,
        provided.filter((variant) => PROTECTED_KINDS.has(variant.kind)),
        limits,
      );
      const budget = terminologyBudget({
        protectedCount: protectedSet.variants.length,
        multiQuery: [
          ...(termVariant && !protectedSet.variants.some((variant) => textKey(variant.text) === textKey(termVariant.text)) ? [termVariant] : []),
          ...provided.filter((variant) => MULTI_QUERY_KINDS.has(variant.kind)),
        ],
        termSearch,
        maxSearches: queryParams.max_searches,
        maxMultiQuery: queryParams.max_llm_variants,
      });
      limits = { ...limits, cap: budget.variantCap };
      termSearch = budget.termSearch;
      searchCut = budget.search_cut;
    }
  }
  const { variants, cuts, terminologyCut } = buildQueryVariantSet(input.query, language, translated, provided, limits, termVariant);
  if (queryLayer?.plan && cuts.length > 0) {
    queryLayer = { ...queryLayer, plan: { ...queryLayer.plan, skipped: [...(queryLayer.plan.skipped ?? []), ...cuts] } };
  }
  if (term) {
    terminology = { ...term, termSearch };
    recordTerminologyCuts(collector, { search_cut: searchCut, variant_cut: terminologyCut ? 1 : 0 });
  }

  return {
    referenced,
    queryContext,
    queryLanguage: language,
    filters,
    variants,
    ...(queryLayer ? { queryLayer } : {}),
    terminology,
  };
}