import type { RetrievalFilters } from '../../backend/types';
import type { RagConfig, StageName } from '../../config';
import { legacyAnalyze } from '../../legacy/enhanced-retrieval';
import { buildRetrievalFilters } from '../../query/filters';
import { queryLanguage } from '../../query/language';
import { getTranslator, NONE_TRANSLATOR_NAME } from '../../query/translate';
import { buildQueryVariants } from '../../query/variants';
import { timeframeToDateRange } from '../../query/timeframe';
import { defaultQueryContext, type TemporalQueryContext } from '../../query/temporal-query-detector';
import { runRefsStage, runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';
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
}

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

  const translator = getTranslator();
  const translation = await runStage(
    spec('translate', 'skip'),
    signal,
    (stageSignal) => translator.translate(input.query, { signal: stageSignal, sourceLanguage: language }),
    collector,
    { detail: () => (translator.name === NONE_TRANSLATOR_NAME ? 'translator_none' : undefined) },
  );

  const filters = buildRetrievalFilters({
    explicit: input.retrievalFilters,
    referencedDocumentIds: referencedDocumentIds(referenced),
  });

  return {
    referenced,
    queryContext,
    queryLanguage: language,
    filters,
    variants: buildQueryVariants(input.query, language, translation.skipped ? [] : translation.value, input.queryVariants ?? []),
  };
}