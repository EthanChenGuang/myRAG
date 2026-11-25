import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { DetectorId, DetectorVerdict } from './detectors';

export interface VerdictCache {
  get(key: string): DetectorVerdict | undefined;
  set(key: string, verdict: DetectorVerdict): void;
  readonly size: number;
  entries(): Array<[string, DetectorVerdict]>;
}

export function verdictCacheKey(_scope: TenantScope, _detector: DetectorId, _modelVersion: string, _text: string): string {
  return '';
}

export function createVerdictCache(_options: { maxEntries: number }): VerdictCache {
  return { get: () => undefined, set: () => undefined, size: 0, entries: () => [] };
}
