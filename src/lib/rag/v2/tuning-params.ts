import {
  DiversityParamsSchema,
  DupClusterParamsSchema,
  TableLookupParamsSchema,
  type DiversityParams,
  type TableLookupParams,
} from '@/lib/rag-eval/contracts.generated';
import type { RagConfig } from '../config';
import type { Profile } from '../types';
import type { RetrievalConfigHashTuning } from './config-hash';
import { effectiveRetrievalParams } from './retrieval-params';

export interface TuningParams {
  tableLookup: TableLookupParams;
  diversity: DiversityParams;
  dupClusterThreshold: number;
}

/** The eval-only part of RetrievalOverrides that tunes the Phase 4.2 stages; ignored for every other profile. */
export interface TuningOverrides {
  table_lookup?: Partial<TableLookupParams> | null;
  diversity?: Partial<DiversityParams> | null;
  dup_cluster?: {
    threshold?: number;
    by_profile?: Record<string, { threshold: number; source: 'fixture' | 'live' }>;
  } | null;
}

export interface TuningParamsOptions {
  /** The committed `mmr_lambda`; defaults to the effective retrieval parameters' field. */
  committedMmrLambda?: number;
  /** Selects a per-profile duplicate threshold from an eval override. */
  embeddingProfileId?: string;
}

const TABLE_LOOKUP_DEFAULTS: TableLookupParams = TableLookupParamsSchema.parse({});
const DIVERSITY_DEFAULTS: DiversityParams = DiversityParamsSchema.parse({});
const DUP_CLUSTER_THRESHOLD_DEFAULT: number = DupClusterParamsSchema.parse({}).threshold;

const loggedProblems = new Set<string>();

function problem(field: string): void {
  if (loggedProblems.has(field)) return;
  loggedProblems.add(field);
  console.warn('[RAG Config] Invalid eval tuning override, entry ignored', { field });
}

function merged<T extends object>(field: string, current: T, override: Partial<T> | null | undefined, parse: (value: unknown) => { success: boolean; data?: T }): T {
  if (!override) return current;
  const result = parse({ ...current, ...override });
  if (!result.success || !result.data) {
    problem(field);
    return current;
  }
  return result.data;
}

function committedLambda(profile: Profile, config: Pick<RagConfig, 'v2'>, options?: TuningParamsOptions): number | undefined {
  if (options && 'committedMmrLambda' in options) return options.committedMmrLambda;
  return effectiveRetrievalParams(profile, config as RagConfig, null).mmr_lambda;
}

function evalDupThreshold(overrides: TuningOverrides['dup_cluster'], embeddingProfileId: string | undefined): number {
  if (!overrides) return DUP_CLUSTER_THRESHOLD_DEFAULT;
  const parsed = DupClusterParamsSchema.safeParse({ threshold: DUP_CLUSTER_THRESHOLD_DEFAULT, ...overrides });
  if (!parsed.success) {
    problem('dup_cluster');
    return DUP_CLUSTER_THRESHOLD_DEFAULT;
  }
  const entry = embeddingProfileId ? parsed.data.by_profile?.[embeddingProfileId] : undefined;
  return entry ? entry.threshold : parsed.data.threshold;
}

/**
 * D-16, D-48, D-49: contract defaults, then the committed `mmr_lambda` when the file carries one, then eval-only
 * request overrides (profile eval only). A fixture-fitted duplicate threshold can only arrive as an eval override.
 */
export function effectiveTuningParams(
  profile: Profile,
  config: Pick<RagConfig, 'v2'>,
  overrides?: TuningOverrides | null,
  options?: TuningParamsOptions,
): TuningParams {
  const lambda = committedLambda(profile, config, options);
  let tableLookup = TABLE_LOOKUP_DEFAULTS;
  let diversity: DiversityParams = lambda === undefined ? DIVERSITY_DEFAULTS : { ...DIVERSITY_DEFAULTS, mmr_lambda: lambda };
  let dupClusterThreshold = DUP_CLUSTER_THRESHOLD_DEFAULT;
  if (profile === 'eval' && overrides) {
    tableLookup = merged('table_lookup', tableLookup, overrides.table_lookup, (value) => TableLookupParamsSchema.safeParse(value));
    diversity = merged('diversity', diversity, overrides.diversity, (value) => DiversityParamsSchema.safeParse(value));
    dupClusterThreshold = evalDupThreshold(overrides.dup_cluster, options?.embeddingProfileId);
  }
  return { tableLookup: { ...tableLookup }, diversity: { ...diversity }, dupClusterThreshold };
}

/** D-34: the hash entries of the switches that are on, or null when none is, so the off-hash keeps its value. */
export function tuningHashComponent(config: Pick<RagConfig, 'v2'>, params: TuningParams): RetrievalConfigHashTuning | null {
  const v2 = config.v2;
  const tuning: RetrievalConfigHashTuning = {
    ...(v2.tableLookup
      ? { table_lookup: { min_cells: params.tableLookup.min_cells, limit: params.tableLookup.limit, weight: params.tableLookup.weight } }
      : {}),
    ...(v2.resultDiversity === 'collapse' ? { diversity: { mode: 'collapse' as const } } : {}),
    ...(v2.resultDiversity === 'mmr'
      ? { diversity: { mode: 'mmr' as const, mmr_lambda: params.diversity.mmr_lambda, mmr_window_factor: params.diversity.mmr_window_factor } }
      : {}),
    ...(v2.versionScope ? { version_scope: true as const } : {}),
    ...(v2.identifierFilter ? { identifier_filter: true as const } : {}),
    ...(v2.dupClusters ? { dup_clusters: true as const } : {}),
    ...(v2.identifierIndex ? { identifier_index: true as const } : {}),
  };
  return Object.keys(tuning).length > 0 ? tuning : null;
}

export interface DupClusterThresholdOptions {
  /** True only in the eval harness: a fixture-fitted entry applies. */
  evalRun?: boolean;
}

export function dupClusterThreshold(_embeddingProfileId: string | null, _options: DupClusterThresholdOptions = {}): number {
  return DUP_CLUSTER_THRESHOLD_DEFAULT;
}

export function dupClusterParamsHaveProfileEntries(): boolean {
  return false;
}

export function setDupClusterParamsForTests(_filePath: string): void {}

export function resetDupClusterParamsForTests(): void {}

export function resetTuningParamsForTests(): void {
  loggedProblems.clear();
}
