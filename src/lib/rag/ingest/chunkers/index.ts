import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { ProcessingProfile } from '../profiles/load';
import type { ChunkResult } from '../types';

export type ChunkerConfig = ProcessingProfile['chunker'];
export type DoclingChunk = ParseResult['chunks'][number];

export interface ChunkSource {
  markdown: string;
  chunks?: readonly DoclingChunk[] | null;
}

export type Chunker = (markdown: string, config: ChunkerConfig) => ChunkResult;

export class ChunkerUnavailableError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`[Ingest] chunker ${kind} is not available`);
    this.name = 'ChunkerUnavailableError';
    this.kind = kind;
  }
}

export const CHUNKERS: Partial<Record<ChunkerConfig['kind'], Chunker>> = {};

export function chunkDocument(_chunker: ChunkerConfig, _parse: ChunkSource): ChunkResult {
  return { chunks: [], warnings: [] };
}
