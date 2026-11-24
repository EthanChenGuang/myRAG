import type { ChunkResult } from '../types';
import type { MarkdownChunkOptions } from './markdown-sections';

export function chunkInvoice(_markdown: string, _options: MarkdownChunkOptions): ChunkResult {
  return { chunks: [], warnings: [] };
}
