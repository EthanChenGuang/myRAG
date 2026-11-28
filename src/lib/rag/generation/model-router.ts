import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryParams, QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { DEFAULT_ROUTING_QUALITY_MODEL, type ModelRoutingConfig } from '../config';
import { isLongQuery, type GateResult, type GateRuleId, type Lang } from '../query/rewrite-gate';

export type ModelTier = 'fast' | 'quality';
export type ModelSelection = 'auto' | 'explicit';

export const AUTO_MODEL_ID = 'auto';

/** D-20 rule ids on the trace (`model_route.rule`); never the query or the prompt. */
export type ModelRouteRule =
  | 'simple_lookup'
  | 'conversational_lookup'
  | 'conversational_no_hit'
  | 'not_document_search'
  | 'no_classification'
  | 'gate_comparison'
  | 'gate_elliptical'
  | 'gate_compound'
  | 'gate_language_mismatch'
  | 'decomposed'
  | 'translated'
  | 'long_query'
  | 'large_context'
  | 'invalid_routing_id'
  | 'explicit_choice'
  | 'routing_off'
  | 'not_generated';

export interface RouteModelInput {
  /** The question as asked (the R11 length rule). */
  query: string;
  /** Phase 6 D-09: the classifyQuery result the route already computed. */
  classification: QueryClassification | null | undefined;
  /** The gate result; absent: the reasons recorded on the plan's gate. */
  gate?: Pick<GateResult, 'reasons' | 'lang'> | null;
  /** The final QueryPlan; absent when the query layer did not run. */
  plan: QueryPlan | null | undefined;
  /**
   * D-20 revision 1: the route found at least one retrieved chunk and attached a non-empty context. Computed by the route from
   * the retrieval result, never from the request.
   */
  retrievalHit?: boolean;
  /** Tokens of the assembled context. */
  contextTokens: number;
  params: Pick<QueryParams, 'routing_fast_max_context_tokens'>;
  ids: Pick<ModelRoutingConfig, 'fastModel' | 'qualityModel'>;
}

export interface ModelRouteDecision {
  tier: ModelTier;
  rule: ModelRouteRule;
  modelId: string;
}

export interface RequestedModelResolution {
  /** A concrete model id; never `auto`. */
  modelId: string;
  selection: ModelSelection;
  /** True only for an Auto selection with RAG_MODEL_ROUTING=auto: routeModel may lower it after retrieval. */
  routable: boolean;
}

const QUALITY_GATE_RULES: ReadonlyArray<readonly [GateRuleId, ModelRouteRule]> = [
  ['R3_COMPARISON', 'gate_comparison'],
  ['R5_ELLIPTICAL', 'gate_elliptical'],
  ['R6_COMPOUND', 'gate_compound'],
  ['R8_LANGUAGE_MISMATCH', 'gate_language_mismatch'],
];

function isAuto(modelId: string | null | undefined): boolean {
  return (modelId ?? '').trim().toLowerCase() === AUTO_MODEL_ID;
}

function concrete(modelId: string | null | undefined): string | null {
  const value = (modelId ?? '').trim();
  return value === '' || isAuto(value) ? null : value;
}

function qualityId(routing: Pick<ModelRoutingConfig, 'qualityModel'>): string {
  return concrete(routing.qualityModel) ?? DEFAULT_ROUTING_QUALITY_MODEL;
}

/**
 * D-19, research Pitfall 7: the single resolution point of a requested selection. An explicit id stays; `auto` is the quality
 * model (routing off) or the quality model marked routable (routing auto); an empty request takes `fallback`. Never `auto`.
 */
export function resolveRequestedModel(
  requested: string | null | undefined,
  routing: Pick<ModelRoutingConfig, 'mode' | 'qualityModel'>,
  fallback?: string | null,
): RequestedModelResolution {
  if (isAuto(requested)) return { modelId: qualityId(routing), selection: 'auto', routable: routing.mode === 'auto' };
  const explicit = concrete(requested) ?? concrete(fallback);
  if (explicit) return { modelId: explicit, selection: 'explicit', routable: false };
  return { modelId: qualityId(routing), selection: isAuto(fallback) ? 'auto' : 'explicit', routable: false };
}

/**
 * D-20: pure rule router for a routable Auto turn, after retrieval and before generation. Fast only for a simple lookup
 * (`document_search`) or, per D-20 revision 1, a `conversational` turn with a retrieval hit; both pass the same structural guards.
 * Every other turn keeps the quality model. No LLM call, no retrieval.
 */
export function routeModel(input: RouteModelInput): ModelRouteDecision {
  const quality = concrete(input.ids.qualityModel) ?? DEFAULT_ROUTING_QUALITY_MODEL;
  const toQuality = (rule: ModelRouteRule): ModelRouteDecision => ({ tier: 'quality', rule, modelId: quality });
  const fast = concrete(input.ids.fastModel);
  if (!fast || !concrete(input.ids.qualityModel)) return toQuality('invalid_routing_id');

  if (!input.classification) return toQuality('no_classification');
  const category = input.classification.category;
  if (category === 'conversational') {
    if (input.retrievalHit !== true) return toQuality('conversational_no_hit');
  } else if (category !== 'document_search') {
    return toQuality('not_document_search');
  }

  const reasons = new Set<string>(input.gate?.reasons ?? input.plan?.gate?.reasons ?? []);
  for (const [reason, rule] of QUALITY_GATE_RULES) if (reasons.has(reason)) return toQuality(rule);

  const plan = input.plan;
  const variants = plan?.variants ?? [];
  if ((plan?.sub_questions?.length ?? 0) > 0 || variants.some((variant) => variant.kind === 'sub_question')) return toQuality('decomposed');
  if (variants.some((variant) => variant.kind === 'translated')) return toQuality('translated');

  const lang: Lang = input.gate?.lang ?? plan?.gate?.lang ?? plan?.language ?? 'en';
  if (isLongQuery(input.query, lang)) return toQuality('long_query');
  if (!(input.contextTokens < input.params.routing_fast_max_context_tokens)) return toQuality('large_context');

  return { tier: 'fast', rule: category === 'conversational' ? 'conversational_lookup' : 'simple_lookup', modelId: fast };
}

/** D-20 trace shape (`model_route`): tier, rule id and how the model was selected; never a prompt or the query. */
export interface ModelRouteTrace {
  tier: ModelTier;
  rule: ModelRouteRule;
  selection: ModelSelection;
}

/**
 * The trace before (or without) routing: an explicit choice keeps its model (fast only when it is the fast id), Auto with routing
 * off is the quality model, and a routable Auto turn stays quality until routeModel decides on a generated turn.
 */
export function initialModelRoute(
  resolution: RequestedModelResolution,
  routing: Pick<ModelRoutingConfig, 'fastModel'>,
): ModelRouteTrace {
  if (resolution.selection === 'explicit') {
    return { tier: resolution.modelId === routing.fastModel ? 'fast' : 'quality', rule: 'explicit_choice', selection: 'explicit' };
  }
  return { tier: 'quality', rule: resolution.routable ? 'not_generated' : 'routing_off', selection: 'auto' };
}
