import { loadRagConfig } from '../config';
import { getRagDeps } from '../deps';
import { resolveEffectivePipeline } from './readiness';

/** Whether requests are served by v2 now: false after either fallback of a defaulted v2 (D-07, D-24). */
export function isV2Pipeline(): boolean {
  return resolveEffectivePipeline().pipeline !== 'legacy';
}

/** Whether the Phase 6 query layer runs: RAG_QUERY_LAYER=true under v2 (the config keeps it off under legacy). */
export function isQueryLayerEnabled(): boolean {
  return loadRagConfig(getRagDeps().ragEnv()).queryLayer.enabled;
}

/** D-30: whether the voice profile condenses history server-side now, so the voice agent can skip its own rewrite. */
export function voiceServerCondenses(): boolean {
  const env = getRagDeps().ragEnv();
  const config = loadRagConfig(env);
  if (config.pipelineBlocked !== null || resolveEffectivePipeline(env).pipeline === 'legacy') return false;
  return (
    config.queryLayer.enabled &&
    !config.disabledStages.has('condense') &&
    config.queryLayer.voiceTransforms.includes('condense_history')
  );
}

/** CACHE-01: whether the semantic_cache stage can run now (v2 served, the query layer on, a backend selected); entry points pass cacheContext only then. */
export function isSemanticCacheActive(): boolean {
  const config = loadRagConfig(getRagDeps().ragEnv());
  if (config.pipelineBlocked !== null || !isV2Pipeline()) return false;
  return config.queryLayer.enabled && config.semanticCache.backend !== 'off' && !config.disabledStages.has('semantic_cache');
}
