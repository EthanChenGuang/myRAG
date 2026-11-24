import type { ChunkResult } from '../types';
import type { MarkdownChunkOptions } from './markdown-sections';

export interface LegalChunkOptions extends MarkdownChunkOptions {
  clause_patterns?: readonly string[];
  lead_in_phrases?: readonly string[];
}

export function chunkLegalClauses(_markdown: string, _options: LegalChunkOptions): ChunkResult {
  return { chunks: [], warnings: [] };
}
