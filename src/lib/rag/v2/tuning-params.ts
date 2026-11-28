import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DiversityParamsSchema,
  DupClusterParamsFileSchema,
  DupClusterParamsSchema,
  TableLookupParamsSchema,
  type DiversityParams,
  type DupClusterParamsFile,
  type TableLookupParams,
} from '@/lib/rag-eval/contracts.generated';
import type { RagConfig } from '../config';
import type { Profile } from '../types';
import type { LexicalStamp } from '../lexical/resolve-options';
import { IDENTIFIER_PATTERNS_UNAVAILABLE, LEXICAL_DICTIONARY_UNAVAILABLE, type RetrievalConfigHashTuning } from './config-hash';
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

/**
 * D-34: the hash entries of the switches that are on, or null when none is, so the off-hash keeps its value. A lexical stamp adds the
 * dictionary version and the patterns fingerprint, each only while its switch is on.
 */
export function tuningHashComponent(
  config: Pick<RagConfig, 'v2'>,
  params: TuningParams,
  lexicalStamp?: LexicalStamp,
): RetrievalConfigHashTuning | null {
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
    ...(lexicalStamp && v2.lexicalDictionary ? { lexical_dictionary_version: lexicalStamp.dictVersion ?? LEXICAL_DICTIONARY_UNAVAILABLE } : {}),
    ...(lexicalStamp && v2.identifierIndex ? { identifier_patterns: lexicalStamp.patterns ?? IDENTIFIER_PATTERNS_UNAVAILABLE } : {}),
  };
  return Object.keys(tuning).length > 0 ? tuning : null;
}

export interface DupClusterThresholdOptions {
  /** True only in the eval harness: a fixture-fitted entry applies. */
  evalRun?: boolean;
}

const DUP_CLUSTER_PARAMS_PATH = ['eval', 'config', 'dup-cluster-params.json'] as const;

let dupParamsPath: string | null = null;
let dupParams: DupClusterParamsFile | null | undefined;
let dupParamsWarned = false;

function dupParamsProblem(reason: string): null {
  if (!dupParamsWarned) {
    dupParamsWarned = true;
    console.warn('[RAG Config] eval/config/dup-cluster-params.json is invalid; the duplicate threshold 0.95 applies', { reason });
  }
  return null;
}

/** The committed calibration file, read once per process; a missing file is the normal state until a calibration writes it. */
function committedDupParams(): DupClusterParamsFile | null {
  if (dupParams !== undefined) return dupParams;
  const file = dupParamsPath ?? path.join(process.cwd(), ...DUP_CLUSTER_PARAMS_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    dupParams = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? null : dupParamsProblem('unreadable');
    return dupParams;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    dupParams = dupParamsProblem('not_json');
    return dupParams;
  }
  const parsed = DupClusterParamsFileSchema.safeParse(json);
  dupParams = parsed.success ? parsed.data : dupParamsProblem('schema');
  return dupParams;
}

/**
 * D-49: the duplicate threshold of an embedding profile. Its entry applies when the source is live, or when the source is fixture and
 * the caller is the eval harness (evalRun); otherwise the top-level threshold. No file: 0.95.
 */
export function dupClusterThreshold(embeddingProfileId: string | null, options: DupClusterThresholdOptions = {}): number {
  const params = committedDupParams();
  if (!params) return DUP_CLUSTER_THRESHOLD_DEFAULT;
  const entry = embeddingProfileId ? params.by_profile?.[embeddingProfileId] : undefined;
  if (entry && (entry.source === 'live' || (entry.source === 'fixture' && options.evalRun === true))) return entry.threshold;
  return params.threshold;
}

/** True when the committed file names at least one profile, so a caller needs the embedding profile id. */
export function dupClusterParamsHaveProfileEntries(): boolean {
  const params = committedDupParams();
  return Boolean(params && params.by_profile && Object.keys(params.by_profile).length > 0);
}

export function setDupClusterParamsForTests(filePath: string): void {
  dupParamsPath = filePath;
  dupParams = undefined;
  dupParamsWarned = false;
}

export function resetDupClusterParamsForTests(): void {
  dupParamsPath = null;
  dupParams = undefined;
  dupParamsWarned = false;
}

export function resetTuningParamsForTests(): void {
  loggedProblems.clear();
}
