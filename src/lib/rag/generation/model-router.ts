import type { QueryClassification } from '@/lib/query-classifier';
import type { QueryParams, QueryPlan } from '@/lib/rag-eval/contracts.generated';
import type { ModelRoutingConfig } from '../config';
import type { GateResult } from '../query/rewrite-gate';

export type ModelTier = 'fast' | 'quality';
export type ModelSelection = 'auto' | 'explicit';

export interface RouteModelInput {
  query: string;
  classification: QueryClassification | null | undefined;
  gate?: Pick<GateResult, 'reasons' | 'lang'> | null;
  plan: QueryPlan | null | undefined;
  contextTokens: number;
  params: Pick<QueryParams, 'routing_fast_max_context_tokens'>;
  ids: Pick<ModelRoutingConfig, 'fastModel' | 'qualityModel'>;
}

export interface ModelRouteDecision {
  tier: ModelTier;
  rule: string;
  modelId: string;
}

export interface RequestedModelResolution {
  modelId: string;
  selection: ModelSelection;
  routable: boolean;
}

export function routeModel(input: RouteModelInput): ModelRouteDecision {
  return { tier: 'quality', rule: 'stub', modelId: input.ids.qualityModel };
}

export function resolveRequestedModel(
  requested: string | null | undefined,
  _routing: Pick<ModelRoutingConfig, 'mode' | 'qualityModel'>,
  fallback?: string,
): RequestedModelResolution {
  return { modelId: requested || fallback || '', selection: 'explicit', routable: false };
}
