export const MAX_CHUNK_IDENTIFIERS = 256;
export const MAX_DOCUMENT_IDENTIFIERS = 2048;
export const MAX_IDENTIFIER_CHARS = 200;

export interface ChunkIdentifiers {
  raw: string[];
  norm: string[];
  truncated: number;
}

export function extractChunkIdentifiers(_content: string, _patterns: readonly RegExp[]): ChunkIdentifiers {
  return { raw: [], norm: [], truncated: 0 };
}

export function unionIdentifiers(_results: readonly ChunkIdentifiers[]): ChunkIdentifiers {
  return { raw: [], norm: [], truncated: -1 };
}
