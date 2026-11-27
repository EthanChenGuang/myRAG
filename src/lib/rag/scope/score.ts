import type { ScopeGateResult } from '@/lib/rag-eval/contracts.generated';
import type { CentroidSnapshot } from './centroids';

export interface ScopeCell {
  threshold: number;
  margin: number;
}

export interface ScopeGateFlags {
  translateSkipped?: boolean;
  scopedBinding?: boolean;
}

export interface ScoreScopeInput {
  queryVectors: readonly (Float32Array | readonly number[])[];
  snapshot: CentroidSnapshot | null;
  cell: ScopeCell | null;
  flags?: ScopeGateFlags;
}

export type ScopeScore = Omit<ScopeGateResult, 'latency_ms'>;

export function scoreScope(_input: ScoreScopeInput): ScopeScore {
  return { label: 'unsure', score: null, negative_score: null, reason: 'stub', centroid_count: 0 };
}
