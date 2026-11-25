import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import {
  LEGACY_IMAGE_FLOOR,
  LEGACY_TEXT_FLOOR,
  evalFloorCalibration,
  floorsFromCalibration,
  resetEvalScoreCalibration,
  setEvalScoreCalibration,
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
describe('eval-only fixture score calibration', () => {
  const root = path.resolve(__dirname, '../../..');

  afterEach(() => resetEvalScoreCalibration());

  it('applies the installed calibration to the eval profile only', () => {
    setEvalScoreCalibration({ context_threshold: 0.12 });
    expect(evalFloorCalibration('eval')).toEqual({ context_threshold: 0.12 });
    for (const profile of ['chat', 'embed', 'voice', 'media']) {
      expect(evalFloorCalibration(profile)).toBeNull();
    }
    expect(floorsFromCalibration(evalFloorCalibration('eval'))).toEqual({ text: 0.12, image: LEGACY_IMAGE_FLOOR });
  });

  it('is absent until installed and after a reset', () => {
    expect(evalFloorCalibration('eval')).toBeNull();
    setEvalScoreCalibration({ context_threshold: 0.12 });
    resetEvalScoreCalibration();
    expect(evalFloorCalibration('eval')).toBeNull();
  });

  it('leaves the production legacy profile at 0.65', () => {
    setEvalScoreCalibration({ context_threshold: 0.12 });
    expect(LEGACY_PROFILE.scoreCalibration.context_threshold).toBe(0.65);
    expect(LEGACY_TEXT_FLOOR).toBe(0.65);
    for (const file of [
      'supabase/migrations/0307_embedding_profiles.sql',
      'supabase/single-tenant-setup.sql',
      'supabase/multi-tenant-setup.sql',
    ]) {
      const sql = fs.readFileSync(path.join(root, file), 'utf8');
      expect(sql).toContain('"context_threshold": 0.65');
    }
  });
});
