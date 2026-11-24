import type { EmbeddingProfile } from '../../embeddings/active-profile';

export const MAX_BATCH_INPUTS = 50_000;
export const MAX_BATCH_BYTES = 190 * 1024 * 1024;

export type BatchProfile = Pick<EmbeddingProfile, 'id' | 'provider' | 'model' | 'dims'>;

export interface BatchChunk {
  chunkId: string;
  embeddingTextVersion: number;
  text: string;
}

export interface BatchFile {
  lines: string[];
  customIds: string[];
  bytes: number;
}

export interface BatchLimits {
  maxInputs?: number;
  maxBytes?: number;
}

export function buildBatchLines(_chunks: BatchChunk[], _profile: BatchProfile, _limits: BatchLimits = {}): BatchFile[] {
  return [];
}
