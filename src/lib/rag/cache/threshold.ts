import rawCalibration from '../../../../eval/config/semantic-cache.json';
import { SemanticCacheCalibrationSchema, type SemanticCacheCalibration } from '@/lib/rag-eval/contracts.generated';
import type { SemanticCacheConfig } from '../config';

type Parsed = { ok: true; calibration: SemanticCacheCalibration } | { ok: false };

const parsedByInput = new WeakMap<object, Parsed>();
let warned = false;

function parse(input: unknown): Parsed {
  if (input !== null && typeof input === 'object') {
    const known = parsedByInput.get(input);
    if (known) return known;
  }
  const result = SemanticCacheCalibrationSchema.safeParse(input);
  const parsed: Parsed = result.success ? { ok: true, calibration: result.data } : { ok: false };
  if (!result.success && !warned) {
    warned = true;
    console.warn('[Semantic Cache] eval/config/semantic-cache.json is invalid; using RAG_SEMANTIC_CACHE_MAX_DISTANCE', {
      issues: result.error.issues.length,
    });
  }
  if (input !== null && typeof input === 'object') parsedByInput.set(input, parsed);
  return parsed;
}

/**
 * D-37: the check distance for an embedding profile. A profile whose entry in eval/config/semantic-cache.json has source calibrated
 * uses its max_distance; any other profile, or an invalid file, uses RAG_SEMANTIC_CACHE_MAX_DISTANCE.
 */
export function effectiveCacheThreshold(
  profileId: string,
  config: Pick<SemanticCacheConfig, 'maxDistance'>,
  calibration: unknown = rawCalibration,
): number {
  const parsed = parse(calibration);
  if (!parsed.ok) return config.maxDistance;
  const entry = parsed.calibration.profiles?.find((profile) => profile.embedding_profile_id === profileId);
  return entry?.source === 'calibrated' ? entry.max_distance : config.maxDistance;
}

export function resetCacheThresholdForTests(): void {
  warned = false;
}
