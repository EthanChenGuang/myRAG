import type { EmbeddingProfile } from '../../embeddings/active-profile';
import { OPENAI_NATIVE_DIMS } from '../../embeddings/types';

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

export function batchCustomId(chunk: Pick<BatchChunk, 'chunkId' | 'embeddingTextVersion'>): string {
  return `${chunk.chunkId}:${chunk.embeddingTextVersion}`;
}

/** One /v1/embeddings request per chunk, split by the provider's input-count and file-size limits. */
export function buildBatchLines(chunks: BatchChunk[], profile: BatchProfile, limits: BatchLimits = {}): BatchFile[] {
  const maxInputs = limits.maxInputs ?? MAX_BATCH_INPUTS;
  const maxBytes = limits.maxBytes ?? MAX_BATCH_BYTES;
  const files: BatchFile[] = [];
  let current: BatchFile = { lines: [], customIds: [], bytes: 0 };
  for (const chunk of chunks) {
    const customId = batchCustomId(chunk);
    const body: Record<string, unknown> = { model: profile.model, input: chunk.text };
    if (profile.dims !== OPENAI_NATIVE_DIMS) body.dimensions = profile.dims;
    const line = JSON.stringify({ custom_id: customId, method: 'POST', url: '/v1/embeddings', body });
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (size > maxBytes) throw new Error('[Backfill] batch input too_large for one file');
    if (current.lines.length > 0 && (current.lines.length >= maxInputs || current.bytes + size > maxBytes)) {
      files.push(current);
      current = { lines: [], customIds: [], bytes: 0 };
    }
    current.lines.push(line);
    current.customIds.push(customId);
    current.bytes += size;
  }
  if (current.lines.length > 0) files.push(current);
  return files;
}
