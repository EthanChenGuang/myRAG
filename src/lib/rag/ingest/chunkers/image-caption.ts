import type { ChunkResult } from '../types';

/**
 * An image document has no text to chunk: its one chunk is the caption, which the images stage produces after
 * the parse. This chunker returns no text chunk and says so, so the chunk stage lets the document through.
 */
export function chunkImageCaption(): ChunkResult {
  return { chunks: [], warnings: [], captionOnly: true };
}
