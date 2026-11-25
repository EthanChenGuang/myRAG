import type { FusedHit } from '../fusion/rrf';
import type { QueryVariant } from '../types';

export interface SubQuestionCoverageOptions {
  enabled: boolean;
  max?: number;
}

export interface SubQuestionCoverageResult {
  topK: FusedHit[];
  pool: FusedHit[];
  reserved: number;
}

export function reserveSubQuestionCoverage(
  topK: FusedHit[],
  pool: FusedHit[],
  _variants: readonly QueryVariant[],
  _options: SubQuestionCoverageOptions,
): SubQuestionCoverageResult {
  return { topK, pool, reserved: 0 };
}
