import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectiveCacheThreshold, resetCacheThresholdForTests } from '@/lib/rag/cache/threshold';

vi.mock('../../../eval/config/semantic-cache.json', () => ({
  default: {
    schema_version: 1,
    profiles: [
      {
        embedding_profile_id: 'profile-calibrated',
        max_distance: 0.031,
        source: 'calibrated',
        fitted_at: '2026-01-01T00:00:00.000Z',
        dev: { paraphrase_pairs: 4, near_miss_pairs: 5, paraphrase_hit_rate: 0.75, near_miss_wrong_hit_rate: 0 },
        test: { paraphrase_pairs: 2, near_miss_pairs: 2, paraphrase_hit_rate: 0.5, near_miss_wrong_hit_rate: 0 },
      },
      { embedding_profile_id: 'profile-default', max_distance: 0.02, source: 'default', fitted_at: null, dev: null, test: null },
    ],
  },
}));

const CONFIG = { maxDistance: 0.07 };

describe('effectiveCacheThreshold (D-37)', () => {
  beforeEach(() => {
    resetCacheThresholdForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the max distance of a profile whose entry has source calibrated (the committed file)', () => {
    expect(effectiveCacheThreshold('profile-calibrated', CONFIG)).toBe(0.031);
  });

  it('uses RAG_SEMANTIC_CACHE_MAX_DISTANCE for a profile without an entry or with source default', () => {
    expect(effectiveCacheThreshold('profile-unknown', CONFIG)).toBe(0.07);
    expect(effectiveCacheThreshold('profile-default', CONFIG)).toBe(0.07);
  });

  it('an invalid file logs one [Semantic Cache] warning and falls back to the env value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const invalid = { schema_version: 1, profiles: [{ embedding_profile_id: 'profile-calibrated', max_distance: 0.9, source: 'calibrated' }] };
    expect(effectiveCacheThreshold('profile-calibrated', CONFIG, invalid)).toBe(0.07);
    expect(effectiveCacheThreshold('profile-calibrated', CONFIG, invalid)).toBe(0.07);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[Semantic Cache]');
  });

  it('a calibrated entry for another profile never applies', () => {
    expect(effectiveCacheThreshold('openai-3-small-1536', CONFIG)).toBe(0.07);
  });
});
