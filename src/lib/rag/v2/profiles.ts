import type { RerankTier } from '../rerank/types';
import type { RagConfig } from '../config';
import type { Profile } from '../types';

export interface V2ProfileSettings {
  rerankTier: RerankTier;
  tokenBudget: number;
  compression: boolean;
  deadlineMs: number | null;
  rerankReserveMs: number | null;
  rerankFloorMs: number | null;
}

const VOICE_TOKEN_BUDGET = 2000;
const VOICE_DEADLINE_MS = 800;
const VOICE_RERANK_RESERVE_MS = 50;
const VOICE_RERANK_FLOOR_MS = 80;

function chatLikeSettings(config: RagConfig, tier: RerankTier): V2ProfileSettings {
  return {
    rerankTier: tier,
    tokenBudget: config.v2.tokenBudget,
    compression: config.v2.compression,
    deadlineMs: null,
    rerankReserveMs: null,
    rerankFloorMs: null,
  };
}

export function v2ProfileSettings(profile: Profile, config: RagConfig): V2ProfileSettings {
  if (profile === 'voice') {
    return {
      rerankTier: config.v2.rerankTier.voice,
      tokenBudget: VOICE_TOKEN_BUDGET,
      compression: false,
      deadlineMs: VOICE_DEADLINE_MS,
      rerankReserveMs: VOICE_RERANK_RESERVE_MS,
      rerankFloorMs: VOICE_RERANK_FLOOR_MS,
    };
  }
  if (profile === 'chat') {
    return chatLikeSettings(config, config.v2.rerankTier.chat);
  }
  if (profile === 'embed' || profile === 'eval') {
    return chatLikeSettings(config, config.v2.rerankTier.chat);
  }
  return chatLikeSettings(config, config.v2.rerankTier.chat);
}