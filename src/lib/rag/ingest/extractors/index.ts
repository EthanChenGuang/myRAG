import type { EnhancedMetadata } from '@/lib/temporal-metadata-extractor';

export interface DateCandidate {
  iso: string;
  confidence: number;
  position: number;
}

export interface ChunkExtractorInput {
  content: string;
  enhanced: EnhancedMetadata;
}

export interface ChunkExtraction {
  metadata: Record<string, unknown>;
  dateCandidates?: DateCandidate[];
}

export type ChunkExtractor = (input: ChunkExtractorInput) => ChunkExtraction;

export const EXTRACTORS: Readonly<Record<string, ChunkExtractor>> = {};

export function runChunkExtractors(
  _names: readonly string[],
  _chunk: { content: string },
): { metadata: Record<string, unknown>; dateCandidates: DateCandidate[] } {
  return { metadata: {}, dateCandidates: [] };
}

export function pickDocDate(_candidates: ReadonlyArray<DateCandidate & { chunkIndex: number }>): string | null {
  return null;
}
