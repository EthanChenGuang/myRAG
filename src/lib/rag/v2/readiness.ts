import { loadRagConfig, type RagEnvInput } from '../config';
import { getRagDeps } from '../deps';

export type PipelineFallback = 'none' | 'v2_unavailable' | 'languages_not_configured';

export interface EffectivePipeline {
  pipeline: 'legacy' | 'v2';
  source: 'explicit' | 'default';
  fallback: PipelineFallback;
}

export function isMissingPhase4Function(_error: unknown): boolean {
  return false;
}

export function isV2Available(): boolean {
  return true;
}

export function markV2Unavailable(_rpc: string): void {}

export function resolveEffectivePipeline(env: RagEnvInput = getRagDeps().ragEnv()): EffectivePipeline {
  return { pipeline: loadRagConfig(env).pipeline, source: 'explicit', fallback: 'none' };
}

export function resetV2ReadinessForTests(): void {}
