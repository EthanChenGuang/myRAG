import type { DiversityParams, TableLookupParams } from '@/lib/rag-eval/contracts.generated';
import type { RagConfig } from '../config';
import type { Profile } from '../types';
import type { RetrievalConfigHashTuning } from './config-hash';

export interface TuningParams {
  tableLookup: TableLookupParams;
  diversity: DiversityParams;
  dupClusterThreshold: number;
}

export interface TuningOverrides {
  table_lookup?: Partial<TableLookupParams> | null;
  diversity?: Partial<DiversityParams> | null;
  dup_cluster?: { threshold?: number; by_profile?: Record<string, { threshold: number; source: 'fixture' | 'live' }> } | null;
}

export interface TuningParamsOptions {
  committedMmrLambda?: number;
  embeddingProfileId?: string;
}

export function effectiveTuningParams(
  _profile: Profile,
  _config: Pick<RagConfig, 'v2'>,
  _overrides?: TuningOverrides | null,
  _options?: TuningParamsOptions,
): TuningParams {
  return { tableLookup: { min_cells: 0, limit: 0, weight: 0 }, diversity: { mmr_lambda: 0, mmr_window_factor: 0 }, dupClusterThreshold: 0 };
}

export function tuningHashComponent(_config: Pick<RagConfig, 'v2'>, _params: TuningParams): RetrievalConfigHashTuning | null {
  return { stub: true } as unknown as RetrievalConfigHashTuning;
}

export function resetTuningParamsForTests(): void {}
