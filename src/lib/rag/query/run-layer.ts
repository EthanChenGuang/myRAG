import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { RagConfig, StageName } from '../config';
import { getRagDeps } from '../deps';
import { runStage, stageSpec, type StageSpec } from '../pipeline';
import type { TraceCollector } from '../trace/collector';
import type { HistoryTurn, Profile, QueryLayerOverrides, QueryVariant, RunRetrievalInput, StageOverrides } from '../types';
import type { RelativeDateRange } from './dates';
import type { PostCheckSkipReason } from './post-checks';
import { buildQueryPlan, planToVariants, type SkippedTransform } from './plan';
import { needsRewrite, type GateResult } from './rewrite-gate';
import { getQueryTransformer } from './transformer';

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
}

export interface QueryLayerInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
}

const NO_LAYER_OUTCOME: Readonly<QueryLayerOutcome> = Object.freeze({
  plan: null,
  variants: [],
  dateRange: null,
  handledTranslate: false,
  shortCircuit: null,
});

/** D-38: request overrides apply to the eval profile only, following the Phase 4 requestOverrides gate. */
export function queryLayerOverrides(profile: Profile, overrides: StageOverrides | undefined): QueryLayerOverrides | undefined {
  return profile === 'eval' ? overrides?.queryLayer : undefined;
}

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

export async function runQueryLayer(ctx: QueryLayerInput): Promise<QueryLayerOutcome> {
  const { input, config, profile, signal, collector, stageOverrides } = ctx;
  const deps = getRagDeps();
  const overrides = queryLayerOverrides(profile, stageOverrides);
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const history = usableHistory(input.history);

  const gated = await runStage(
    spec('query_gate', 'skip'),
    signal,
    () => needsRewrite(input.query, { hasHistory: history.length > 0, now: new Date(deps.now()) }),
    collector,
    { rules: (value) => [...value.reasons], detail: gateDetail },
  );
  if (gated.skipped) return { ...NO_LAYER_OUTCOME };
  const gate = gated.value;

  const transformer = getQueryTransformer(overrides?.framework ?? config.queryLayer.framework);
  const skipped: SkippedTransform[] = [];
  let condensed: string | null = null;

  if (gate.transforms.includes('condense_history')) {
    const condenseSpec = spec('condense', 'skip');
    const enabled = condenseSpec.enabled && overrides?.transforms?.condense !== false;
    const outcome = await runStage(
      { ...condenseSpec, enabled },
      signal,
      (stageSignal) =>
        transformer.condense({
          query: input.query,
          history,
          language: gate.lang,
          protectedTokens: gate.protectedTokens,
          signal: stageSignal,
        }),
      collector,
      { detail: (value) => (value.skip ? `discarded=${value.skip.reason}` : value.passThrough ? 'pass_through' : undefined) },
    );
    if (!outcome.skipped) {
      if (outcome.value.skip) {
        skipped.push({ transform: 'condense_history', reason: postCheckReason(outcome.value.skip.reason) });
        console.warn('[Query Layer] condense output discarded', { reason: outcome.value.skip.reason });
      } else if (!outcome.value.passThrough) {
        condensed = outcome.value.standalone;
      }
    } else if (outcome.reason !== 'disabled') {
      skipped.push({ transform: 'condense_history', reason: outcome.reason === 'timeout' ? 'timeout' : 'error' });
    }
  }

  const plan = buildQueryPlan({ original: input.query, gate, framework: transformer.framework, condensed, skipped });
  return { plan, variants: planToVariants(plan), dateRange: null, handledTranslate: false, shortCircuit: null };
}
