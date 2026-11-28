import { extractIdentifierEntries } from '../ids/normalize';

/** Identifiers stored per chunk; later ones are dropped and counted. */
export const MAX_CHUNK_IDENTIFIERS = 256;
/** Identifiers stored on the document (the union of its chunks). */
export const MAX_DOCUMENT_IDENTIFIERS = 2048;
/** Longest raw or normalized identifier stored (IdentifierIndexEntry allows 200); a longer match is skipped and counted. */
export const MAX_IDENTIFIER_CHARS = 200;

export interface ChunkIdentifiers {
  /** Spellings as matched (after NFKC), parallel to norm. */
  raw: string[];
  norm: string[];
  /** Matches left out by the caps. */
  truncated: number;
}

/**
 * The identifiers of one chunk (D-28): the built-in IDENTIFIER_PATTERN plus the tenant's compiled patterns, first seen first,
 * de-duplicated by normalized form. The input length is capped by extractIdentifierEntries. An empty result means indexed with none.
 */
export function extractChunkIdentifiers(content: string, patterns: readonly RegExp[]): ChunkIdentifiers {
  const raw: string[] = [];
  const norm: string[] = [];
  let truncated = 0;
  for (const entry of extractIdentifierEntries(content, patterns)) {
    if (entry.raw.length > MAX_IDENTIFIER_CHARS || entry.norm.length > MAX_IDENTIFIER_CHARS) {
      truncated += 1;
      continue;
    }
    if (norm.length >= MAX_CHUNK_IDENTIFIERS) {
      truncated += 1;
      continue;
    }
    raw.push(entry.raw);
    norm.push(entry.norm);
  }
  return { raw, norm, truncated };
}

/** The document arrays: the chunks' identifiers in order, de-duplicated by normalized form, at most MAX_DOCUMENT_IDENTIFIERS. */
export function unionIdentifiers(results: readonly ChunkIdentifiers[]): ChunkIdentifiers {
  const seen = new Set<string>();
  const raw: string[] = [];
  const norm: string[] = [];
  let truncated = 0;
  for (const result of results) {
    result.norm.forEach((value, index) => {
      if (seen.has(value)) return;
      seen.add(value);
      if (norm.length >= MAX_DOCUMENT_IDENTIFIERS) {
        truncated += 1;
        return;
      }
      norm.push(value);
      raw.push(result.raw[index] ?? value);
    });
  }
  return { raw, norm, truncated };
}
