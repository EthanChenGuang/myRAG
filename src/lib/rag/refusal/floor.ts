import { LEGACY_KEEP_FLOORS, legacyKeepReason, type LegacyKeepCandidate } from '../context/relevance';
import type { RefusalRecord } from './types';

export const LEGACY_TEXT_FLOOR = LEGACY_KEEP_FLOORS.text;
export const LEGACY_IMAGE_FLOOR = LEGACY_KEEP_FLOORS.image;

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
export function setEvalScoreCalibration(calibration: Record<string, number> | null): void {
  evalScoreCalibration = calibration ? Object.freeze({ ...calibration }) : null;
}

export function resetEvalScoreCalibration(): void {
  evalScoreCalibration = null;
}

export function evalFloorCalibration(profile: string): Record<string, number> | null {
  return profile === 'eval' ? evalScoreCalibration : null;
}

/** Refusal when the legacy pool holds no candidate at all: what legacy answers for an empty search. */
export function emptyLegacyPool(topScore: number | null): RefusalRecord {
  return {
    decision: 'refuse',
    basis: 'similarity_floor',
    reason: 'below_similarity_floor',
    topScore,
    threshold: LEGACY_KEEP_FLOORS.text,
    cellKey: null,
  };
}

/** Legacy refusal semantics: answer when any candidate passes the legacy keep rule (similarity, query term, image). */
export function legacyRuleFloor(input: {
  candidates: LegacyKeepCandidate[];
  terms: readonly string[];
  floors: SimilarityFloors;
}): RefusalRecord {
  const { candidates, terms, floors } = input;
  if (candidates.length === 0) return notApplied('no_candidates');

  let bestText: number | null = null;
  let keptByScore = false;
  let keptByTerm = false;
  for (const candidate of candidates) {
    const sim = candidate.similarity;
    const dense = sim !== null && Number.isFinite(sim);
    if (dense && (bestText === null || sim > bestText)) bestText = sim;
    const reason = legacyKeepReason({ ...candidate, similarity: dense ? sim : null }, terms, floors);
    if (reason === 'name') keptByTerm = true;
    else if (reason !== null) keptByScore = true;
  }

  if (keptByScore || keptByTerm) {
    return {
      decision: 'answer',
      basis: 'none',
      reason: keptByScore ? 'above_similarity_floor' : 'query_term_match',
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
