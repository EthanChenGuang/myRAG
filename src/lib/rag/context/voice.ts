import type { ChunkWithScore } from '../rerank/local-hybrid';
import type { VoiceChunk } from '../voice/keyword-fallback';

export interface VoiceResult extends ChunkWithScore {
  image_url: string | null;
}

export interface VoiceSourceImage {
  url: string;
  name: string;
  type: string;
}

export interface VoiceResults {
  results: VoiceResult[];
  source_images: VoiceSourceImage[];
}

export function enrichVoiceCandidates(_chunks: VoiceChunk[]): ChunkWithScore[] {
  return [];
}

export function assembleVoiceResults(_input: { query: string; chunks: ChunkWithScore[]; matchCount: number }): VoiceResults {
  return { results: [], source_images: [] };
}
