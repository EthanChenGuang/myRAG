import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { blockSplitterForIngest, legacyBlockSplitter, type BlockSplitter } from '@/lib/rag/lang/sentences';
import type { ProcessingProfile } from '../profiles/load';
import { effectiveTableHeader } from '../routing/effective-settings';
import type { ChunkDraft, ChunkResult } from '../types';
import { chunkImageCaption } from './image-caption';
import { chunkInvoice } from './invoice';
import { chunkLegalClauses } from './legal-clauses';
import { chunkMarkdownSections } from './markdown-sections';
import { carryTableHeaders, markCarriedChunks } from './markdown-tables';
import { chunkTableAware } from './table-aware';

export type ChunkerConfig = ProcessingProfile['chunker'];
export type ChunkerKind = ChunkerConfig['kind'];
export type DoclingChunk = ParseResult['chunks'][number];

/** What the parse stage hands to chunking: the Markdown, and Docling's own chunks when Docling ran. */
export interface ChunkSource {
  markdown: string;
  chunks?: readonly DoclingChunk[] | null;
}

/** `sentences` picks the sentence splitter of each over-long block (D-15); absent, the legacy shared set. */
export type Chunker = (_markdown: string, _config: ChunkerConfig, _sentences?: BlockSplitter) => ChunkResult;

/** Raised for a chunker kind that no plan has registered yet. */
export class ChunkerUnavailableError extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`[Ingest] chunker ${kind} is not available`);
    this.name = 'ChunkerUnavailableError';
    this.kind = kind;
  }
}

const budget = (config: ChunkerConfig, sentences: BlockSplitter = legacyBlockSplitter) => ({
  maxTokens: config.max_tokens,
  overlapTokens: config.overlap_tokens,
  minChunkTokens: config.min_chunk_tokens,
  repeatTableHeader: config.repeat_table_header,
  sentences,
});

/** Chunkers by profile chunker kind. */
export const CHUNKERS: Partial<Record<ChunkerKind, Chunker>> = {
  markdown_sections: (markdown, config, sentences) => ({ chunks: chunkMarkdownSections(markdown, budget(config, sentences)), warnings: [] }),
  table_aware: (markdown, config, sentences) => chunkTableAware(markdown, budget(config, sentences)),
  invoice: (markdown, config) => chunkInvoice(markdown, budget(config)),
  image_caption: () => chunkImageCaption(),
  legal_clauses: (markdown, config, sentences) =>
    chunkLegalClauses(markdown, {
      ...budget(config, sentences),
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

export interface ChunkDocumentOptions {
  /** RAG_LANGUAGE_AWARE_INGEST: `on` splits each block at its own language's sentence ends; off (or absent) is today's splitter. */
  languageAwareIngest?: 'off' | 'on';
  /** RAG_TABLE_HEADER_REPEAT: `always` repeats every table's header and carries it onto header-less continuations; `profile` (or absent) reads the profile flag. */
  tableHeaderRepeat?: 'profile' | 'always';
}

/** The chunker config with the effective header flag (D-19); the profile's own object when nothing changes, so profile mode is today's call. */
export function withEffectiveHeader(chunker: ChunkerConfig, mode: ChunkDocumentOptions['tableHeaderRepeat']): ChunkerConfig {
  const { repeatTableHeader } = effectiveTableHeader(mode, chunker);
  return repeatTableHeader === chunker.repeat_table_header ? chunker : { ...chunker, repeat_table_header: repeatTableHeader };
}

/**
 * Chunks a parsed document by the profile's chunker kind. Docling's chunks are used as they are (headings as
 * section_path, pages, is_table, plain text) for markdown_sections and table_aware; legal_clauses always chunks
 * the Markdown, because Docling's heading inference does not know clause numbering.
 */
export function chunkDocument(chunker: ChunkerConfig, parse: ChunkSource, options: ChunkDocumentOptions = {}): ChunkResult {
  const chunk = CHUNKERS[chunker.kind];
  if (!chunk) throw new ChunkerUnavailableError(chunker.kind);
  // Docling's chunks keep their own splitting here; the sidecar applies the language rule to them (plan 03.2-23).
  if (DOCLING_KINDS.has(chunker.kind) && parse.chunks && parse.chunks.length > 0) {
    return { chunks: fromDocling(parse.chunks), warnings: [] };
  }
  const config = withEffectiveHeader(chunker, options.tableHeaderRepeat);
  const sentences = blockSplitterForIngest(options.languageAwareIngest);
  if (!effectiveTableHeader(options.tableHeaderRepeat, chunker).carryTableHeader) return chunk(parse.markdown, config, sentences);
  // D-20: header-less continuation tables take the previous table's header before any chunker cuts them.
  const carry = carryTableHeaders(parse.markdown);
  const result = chunk(carry.markdown, config, sentences);
  return { ...result, chunks: markCarriedChunks(result.chunks, carry) };
}
