import type { RankedHit } from '../backend/types';
import type { DedupeResult } from '../fusion/dedupe';
import type { FusedHit } from '../fusion/rrf';

export interface ReserveOptions {
  reserveSlots: number;
  byParent: boolean;
}

export function reserveTerminologyHits(
  result: DedupeResult,
  _fused: readonly FusedHit[],
  _termHits: readonly RankedHit[] | null | undefined,
  _options: ReserveOptions,
): DedupeResult {
  return result;
}
