import type { ChunkResult } from '../types';
import type { MarkdownChunkOptions } from './markdown-sections';

export function chunkTableAware(_markdown: string, _options: MarkdownChunkOptions): ChunkResult {
  return { chunks: [], warnings: [] };
}
