import type { SemanticCacheConfig } from '../config';

export function effectiveCacheThreshold(_profileId: string, config: Pick<SemanticCacheConfig, 'maxDistance'>, _calibration?: unknown): number {
  return config.maxDistance;
}

export function resetCacheThresholdForTests(): void {}
