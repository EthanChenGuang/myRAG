import { describe, expect, it } from 'vitest';
import {
  LEGACY_IMAGE_FLOOR,
  LEGACY_TEXT_FLOOR,
  floorsFromCalibration,
  similarityFloor,
} from '@/lib/rag/refusal/floor';

const legacyCalibration = {
  retrieval_threshold: 0.7,
  context_threshold: 0.65,
  fallback_threshold: 0.28,
  context_image_threshold: 0.25,
};

describe('floorsFromCalibration', () => {
  it('maps legacy row score_calibration to 0.65 and 0.25', () => {
    expect(floorsFromCalibration(legacyCalibration)).toEqual({ text: 0.65, image: 0.25 });
  });

  it('falls back to LEGACY constants for null or out-of-range values', () => {
    expect(floorsFromCalibration(null)).toEqual({ text: LEGACY_TEXT_FLOOR, image: LEGACY_IMAGE_FLOOR });
    expect(floorsFromCalibration({ context_threshold: 1.5, context_image_threshold: -0.1 })).toEqual({
      text: LEGACY_TEXT_FLOOR,
      image: LEGACY_IMAGE_FLOOR,
    });
  });
});

describe('similarityFloor', () => {
  const floors = floorsFromCalibration(legacyCalibration);

  it('answers when best dense similarity is strictly above the text floor', () => {
    const r = similarityFloor({
      floors,
      candidates: [{ similarity: 0.66 }],
    });
    expect(r).toMatchObject({ decision: 'answer', basis: 'none' });
  });

  it('refuses when text similarities are at or below floor and no image rescue', () => {
    const r = similarityFloor({
      floors,
      candidates: [{ similarity: 0.65 }, { similarity: 0.4 }],
    });
    expect(r).toMatchObject({
      decision: 'refuse',
      basis: 'similarity_floor',
      topScore: 0.65,
      threshold: 0.65,
    });
  });

  it('answers when an image chunk exceeds the image floor even if text is weak', () => {
    const r = similarityFloor({
      floors,
      candidates: [
        { similarity: 0.4 },
        { similarity: 0.3, hasImage: true },
      ],
    });
    expect(r.decision).toBe('answer');
  });

  it('returns no_dense_similarity when every similarity is null', () => {
    const r = similarityFloor({
      floors,
      candidates: [{ similarity: null }, { similarity: null }],
    });
    expect(r).toMatchObject({ decision: 'not_applied', reason: 'no_dense_similarity' });
  });

  it('returns no_candidates for an empty list', () => {
    const r = similarityFloor({ floors, candidates: [] });
    expect(r).toMatchObject({ decision: 'not_applied', reason: 'no_candidates' });
  });
});