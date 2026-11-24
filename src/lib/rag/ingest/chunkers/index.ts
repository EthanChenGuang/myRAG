import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { ProcessingProfile } from '../profiles/load';
import type { ChunkDraft, ChunkResult } from '../types';
import { chunkInvoice } from './invoice';
import { chunkLegalClauses } from './legal-clauses';
import { chunkMarkdownSections } from './markdown-sections';
import { chunkTableAware } from './table-aware';

export type ChunkerConfig = ProcessingProfile['chunker'];
export type ChunkerKind = ChunkerConfig['kind'];
export type DoclingChunk = ParseResult['chunks'][number];

/** What the parse stage hands to chunking: the Markdown, and Docling's own chunks when Docling ran. */
export interface ChunkSource {
  markdown: string;
  chunks?: readonly DoclingChunk[] | null;
}

export type Chunker = (_markdown: string, _config: ChunkerConfig) => ChunkResult;

/** Raised for a chunker kind that no plan has registered yet. */
export class ChunkerUnavailableError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`[Ingest] chunker ${kind} is not available`);
    this.name = 'ChunkerUnavailableError';
    this.kind = kind;
  }
}

const budget = (config: ChunkerConfig) => ({
  maxTokens: config.max_tokens,
  overlapTokens: config.overlap_tokens,
  minChunkTokens: config.min_chunk_tokens,
  repeatTableHeader: config.repeat_table_header,
});

/** Chunkers by profile chunker kind; the plan for image_caption registers its own here. */
export const CHUNKERS: Partial<Record<ChunkerKind, Chunker>> = {
  markdown_sections: (markdown, config) => ({ chunks: chunkMarkdownSections(markdown, budget(config)), warnings: [] }),
  table_aware: (markdown, config) => chunkTableAware(markdown, budget(config)),
  invoice: (markdown, config) => chunkInvoice(markdown, budget(config)),
  legal_clauses: (markdown, config) =>
    chunkLegalClauses(markdown, {
      ...budget(config),
      clause_patterns: config.clause_patterns ?? [],
      lead_in_phrases: config.lead_in_phrases ?? [],
    }),
};

/** Kinds whose chunks may come from Docling's HybridChunker instead of the Markdown chunkers. */
const DOCLING_KINDS: ReadonlySet<ChunkerKind> = new Set<ChunkerKind>(['markdown_sections', 'table_aware']);

function fromDocling(chunks: readonly DoclingChunk[]): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const chunk of chunks) {
    if (chunk.text.trim() === '') continue;
    drafts.push({
      content: chunk.text,
      section_path: [...chunk.headings],
      chunk_kind: chunk.is_table ? 'table' : 'text',
      page_start: chunk.pages.length > 0 ? Math.min(...chunk.pages) : null,
      page_end: chunk.pages.length > 0 ? Math.max(...chunk.pages) : null,
      metadata: {},
    });
  }
  return drafts;
}

/**
 * Chunks a parsed document by the profile's chunker kind. Docling's chunks are used as they are (headings as
 * section_path, pages, is_table, plain text) for markdown_sections and table_aware; legal_clauses always chunks
 * the Markdown, because Docling's heading inference does not know clause numbering.
 */
export function chunkDocument(chunker: ChunkerConfig, parse: ChunkSource): ChunkResult {
  const chunk = CHUNKERS[chunker.kind];
  if (!chunk) throw new ChunkerUnavailableError(chunker.kind);
  if (DOCLING_KINDS.has(chunker.kind) && parse.chunks && parse.chunks.length > 0) {
    return { chunks: fromDocling(parse.chunks), warnings: [] };
  }
  return chunk(parse.markdown, chunker);
}
