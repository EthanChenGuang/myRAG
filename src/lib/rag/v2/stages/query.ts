import type { RetrievalFilters } from '../../backend/types';
import type { RagConfig, StageName } from '../../config';
import { legacyAnalyze } from '../../legacy/enhanced-retrieval';
import { buildRetrievalFilters } from '../../query/filters';
import { mergeLayerDateRange } from '../../query/layer-filters';
import { queryLanguage } from '../../query/language';
import { getTranslator, NONE_TRANSLATOR, NONE_TRANSLATOR_NAME } from '../../query/translate';
import { buildQueryVariantSet, PHASE4_VARIANT_LIMITS, queryLayerVariantLimits, type TranslatedQuery } from '../../query/variants';
import { timeframeToDateRange } from '../../query/timeframe';
import { defaultQueryContext, type TemporalQueryContext } from '../../query/temporal-query-detector';
import { runRefsStage, runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';
import type { QueryLayerOutcome } from '../../query/run-layer';
import type { QueryLanguage } from '../../refusal/gate';

export interface QueryStagesInput {
  input: RunRetrievalInput;
  scope: TenantScope;
  config: RagConfig;
  profile: Profile;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
}

export interface QueryStagesOutput {
  referenced: ReferencedState | null;
  queryContext: TemporalQueryContext;
  queryLanguage: QueryLanguage | null;
  filters: RetrievalFilters;
  variants: QueryVariant[];
  /** D-11: the query layer's whole outcome; absent while the layer is off. */
  queryLayer?: QueryLayerOutcome;
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

  let queryLayer: QueryLayerOutcome | undefined;
  if (queryLayerActive(config, profile, stageOverrides)) {
    const { runQueryLayer } = await import('../../query/run-layer');
    queryLayer = await runQueryLayer({ input, config, profile, signal, collector, stageOverrides });
  }

  let translated: TranslatedQuery[] = [];
  if (queryLayer?.handledTranslate) {
    const at = collector.now();
    collector.record({ name: 'translate', status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at, detail: HANDLED_BY_QUERY_LAYER });
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

  const built = buildRetrievalFilters({
    explicit: input.retrievalFilters,
    referencedDocumentIds: referencedDocumentIds(referenced),
  });
  const filters = queryLayer?.dateRange ? mergeLayerDateRange(built, queryLayer.dateRange) : built;

  // D-08: the layer's max_searches and group limits replace the Phase 4 cap of three; every cut is recorded on the plan.
  let limits = PHASE4_VARIANT_LIMITS;
  if (queryLayer) {
    const { effectiveQueryParams } = await import('../../query/query-params');
    limits = queryLayerVariantLimits(effectiveQueryParams(profile, profile === 'eval' ? stageOverrides?.queryLayer?.queryParams : undefined));
  }
  const { variants, cuts } = buildQueryVariantSet(
    input.query,
    language,
    translated,
    [...(queryLayer?.variants ?? []), ...(input.queryVariants ?? [])],
    limits,
  );
  if (queryLayer?.plan && cuts.length > 0) {
    queryLayer = { ...queryLayer, plan: { ...queryLayer.plan, skipped: [...(queryLayer.plan.skipped ?? []), ...cuts] } };
  }

  return {
    referenced,
    queryContext,
    queryLanguage: language,
    filters,
    variants,
    ...(queryLayer ? { queryLayer } : {}),
  };
}