import type { Profile } from './types';

export const CORE_STAGES = ['embed', 'search'] as const;
export const OPTIONAL_STAGES = [
  'analyze',
  'legacy_rank',
  'post_filter',
  'assemble',
  'voice_keyword_fallback',
  'local_rerank',
] as const;

export type CoreStageName = (typeof CORE_STAGES)[number];
export type OptionalStageName = (typeof OPTIONAL_STAGES)[number];
export type StageName = CoreStageName | OptionalStageName;

export type StageTimeouts = Partial<Record<StageName, number>>;

export const PROFILE_STAGE_DEFAULTS: Record<Profile, StageTimeouts> = {
  chat: {},
  embed: {},
  eval: {},
  media: {},
  voice: {},
};

export interface RagEnvInput {
  RAG_PIPELINE?: string;
  RAG_DISABLED_STAGES?: string;
  RAG_STAGE_TIMEOUTS?: string;
}

export interface RagConfig {
  pipeline: 'legacy';
  disabledStages: ReadonlySet<StageName>;
  timeouts: Record<Profile, StageTimeouts>;
  warnings: string[];
}

export function loadRagConfig(_env: RagEnvInput): RagConfig {
  return { pipeline: 'legacy', disabledStages: new Set(), timeouts: PROFILE_STAGE_DEFAULTS, warnings: [] };
}

export function resetRagConfigForTests(): void {}
