import { QueryParamsSchema, type QueryParams, type RagRunRequest } from '@/lib/rag-eval/contracts.generated';
import type { Profile } from '../types';

type RunQueryParams = NonNullable<NonNullable<NonNullable<RagRunRequest['options']>['query_params']>>;
export type QueryParamsOverrides = Partial<Omit<RunQueryParams, 'query_budget_ms'>> & {
  query_budget_ms?: Partial<NonNullable<RunQueryParams['query_budget_ms']>> | null;
};

export function resetQueryParamsWarningsForTests(): void {}

export function parseCommittedQueryParams(_raw: unknown): QueryParams {
  return QueryParamsSchema.parse({ max_searches: 1 });
}

export function effectiveQueryParams(_profile: Profile, _overrides?: QueryParamsOverrides | null): QueryParams {
  return QueryParamsSchema.parse({ max_searches: 1 });
}
