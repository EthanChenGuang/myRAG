import rawParams from '../../../../eval/config/query-params.json';
import { QueryParamsSchema, type QueryParams, type RagRunRequest } from '@/lib/rag-eval/contracts.generated';
import type { Profile } from '../types';

type RunQueryParams = NonNullable<NonNullable<NonNullable<RagRunRequest['options']>['query_params']>>;
type BudgetProfile = 'chat' | 'embed' | 'voice';
type ScalarField = Exclude<keyof RunQueryParams, 'query_budget_ms'>;

/** Eval-only per-request overrides (RagRunOptions.query_params); null or absent fields keep the committed value. */
export type QueryParamsOverrides = Partial<Omit<RunQueryParams, 'query_budget_ms'>> & {
  query_budget_ms?: Partial<Record<BudgetProfile, number | null>> | null;
};

const SCALAR_FIELDS: readonly ScalarField[] = [
  'group_deadline_ms',
  'history_turn_chars',
  'history_turns',
  'max_llm_variants',
  'max_searches',
  'max_sub_questions',
  'max_translations',
  'variant_max_chars',
  'variant_max_ratio',
];
const BUDGET_PROFILES: readonly BudgetProfile[] = ['chat', 'embed', 'voice'];

const loggedProblems = new Set<string>();

function problem(key: string, message: string, data: Record<string, unknown>): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Query Layer] ${message}`, data);
}

export function resetQueryParamsWarningsForTests(): void {
  loggedProblems.clear();
}

function copy(params: QueryParams): QueryParams {
  return { ...params, ...(params.query_budget_ms ? { query_budget_ms: { ...params.query_budget_ms } } : {}) };
}

/** Validates the committed query-params.json; an invalid file falls back to the QueryParams defaults (D-08). */
export function parseCommittedQueryParams(raw: unknown): QueryParams {
  const parsed = QueryParamsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  problem('committed-invalid', 'eval/config/query-params.json is invalid, using the QueryParams defaults', {
    fields: parsed.error.issues.map((issue) => issue.path.join('.')).slice(0, 8),
  });
  return QueryParamsSchema.parse({});
}

const COMMITTED: QueryParams = parseCommittedQueryParams(rawParams);

/** Applies one candidate value; an invalid value keeps the previous one with one warning per field and value. */
function accept(current: QueryParams, candidate: QueryParams, field: string, value: unknown): QueryParams {
  if (QueryParamsSchema.safeParse(candidate).success) return candidate;
  problem(`override:${field}:${String(value)}`, 'Invalid query_params override, previous value kept', { field, value });
  return current;
}

function applyEvalOverrides(current: QueryParams, overrides: QueryParamsOverrides): QueryParams {
  let next = current;
  for (const field of SCALAR_FIELDS) {
    const value = overrides[field];
    if (value === null || value === undefined) continue;
    next = accept(next, { ...next, [field]: value }, field, value);
  }
  const budget = overrides.query_budget_ms;
  if (budget) {
    for (const entry of BUDGET_PROFILES) {
      const value = budget[entry];
      if (value === null || value === undefined) continue;
      const base = next.query_budget_ms ?? QueryParamsSchema.parse({ query_budget_ms: {} }).query_budget_ms!;
      next = accept(next, { ...next, query_budget_ms: { ...base, [entry]: value } }, `query_budget_ms.${entry}`, value);
    }
  }
  return next;
}

/** Committed query-params.json, then eval-only request overrides (profile eval only). Returns a fresh copy. */
export function effectiveQueryParams(profile: Profile, overrides?: QueryParamsOverrides | null): QueryParams {
  let params = COMMITTED;
  if (profile === 'eval' && overrides) params = applyEvalOverrides(params, overrides);
  return copy(params);
}
