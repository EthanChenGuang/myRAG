import { resolveEffectivePipeline } from './readiness';

/** Whether requests are served by v2 now: false after either fallback of a defaulted v2 (D-07, D-24). */
export function isV2Pipeline(): boolean {
  return resolveEffectivePipeline().pipeline !== 'legacy';
}
