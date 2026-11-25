import type { RefusalRecord } from './types';

export const LEGACY_TEXT_FLOOR = 0.65;
export const LEGACY_IMAGE_FLOOR = 0.25;

export interface SimilarityFloors {
  text: number;
  image: number;
}

export interface FloorCandidate {
  similarity: number | null;
  hasImage?: boolean;
}

function inUnitOpen(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1;
}

export function floorsFromCalibration(calibration: Record<string, unknown> | null | undefined): SimilarityFloors {
  const textRaw = calibration?.context_threshold;
  const imageRaw = calibration?.context_image_threshold;
  return {
    text: inUnitOpen(textRaw) ? textRaw : LEGACY_TEXT_FLOOR,
    image: inUnitOpen(imageRaw) ? imageRaw : LEGACY_IMAGE_FLOOR,
  };
}

function notApplied(reason: RefusalRecord['reason']): RefusalRecord {
  return {
    decision: 'not_applied',
    basis: 'none',
    reason,
    topScore: null,
    threshold: null,
    cellKey: null,
  };
}

export function similarityFloor(input: { candidates: FloorCandidate[]; floors: SimilarityFloors }): RefusalRecord {
  const { candidates, floors } = input;
  if (candidates.length === 0) return notApplied('no_candidates');

  let hasDense = false;
  let bestText: number | null = null;
  let imageRescue = false;

  for (const candidate of candidates) {
    const sim = candidate.similarity;
    if (sim === null || !Number.isFinite(sim)) continue;
    hasDense = true;
    if (bestText === null || sim > bestText) bestText = sim;
    if (candidate.hasImage && sim > floors.image) imageRescue = true;
  }

  if (!hasDense) return notApplied('no_dense_similarity');

  const textPass = bestText !== null && bestText > floors.text;
  if (textPass || imageRescue) {
    return {
      decision: 'answer',
      basis: 'none',
      reason: 'above_similarity_floor',
      topScore: bestText,
      threshold: floors.text,
      cellKey: null,
    };
  }

  return {
    decision: 'refuse',
    basis: 'similarity_floor',
    reason: 'below_similarity_floor',
    topScore: bestText,
    threshold: floors.text,
    cellKey: null,
  };
}
let evalScoreCalibration: Record<string, number> | null = null;

/** Eval harness only: a fixture-fitted score_calibration for the eval profile; every other profile ignores it. */
export function setEvalScoreCalibration(_calibration: Record<string, number> | null): void {}

export function resetEvalScoreCalibration(): void {
  evalScoreCalibration = null;
}

export function evalFloorCalibration(_profile: string): Record<string, number> | null {
  return evalScoreCalibration;
}
