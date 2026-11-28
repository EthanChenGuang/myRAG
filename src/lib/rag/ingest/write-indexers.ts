import { extractChunkIdentifiers, unionIdentifiers, type ChunkIdentifiers } from '../identifiers/extract';
import { loadAttributeIdentifiers, mergeAttributeIdentifiers, type AttributeIdentifierEntry } from './attributes/identifier-feed';
import { loadTenantIdentifierPatterns, type TenantIdentifierPatterns } from '../identifiers/patterns';
import { parseTableRows, type TableTruncation } from '../tables/parse';
import type { TenantScope } from '../tenant/scope';
import { IngestWriterError, type IndexChunkRow, type IngestWriter } from './writer';

export const INDEX_WARNING_CODES = ['index_tables_failed', 'index_identifiers_failed', 'identifier_patterns_unavailable'] as const;
export type IndexWarningCode = (typeof INDEX_WARNING_CODES)[number];

/** Chunks read per rag_index_document_chunks page and identifier rows per rag_write_chunk_identifiers call. */
export const INDEX_PAGE_SIZE = 500;

export type LookupIndexWriter = Pick<IngestWriter, 'listDocumentChunksForIndex' | 'writeChunkIdentifiers' | 'writeTableRows'>;

export interface IndexDocumentInput {
  writer: LookupIndexWriter;
  /** The tenant the writer is bound to; tenant identifier patterns are loaded for it. */
  scope: TenantScope;
  documentId: string;
  /** RAG_TABLE_LOOKUP: write rag_table_rows. */
  tables: boolean;
  /** RAG_IDENTIFIER_INDEX: write identifiers on chunks and the document. */
  identifiers: boolean;
  signal: AbortSignal;
  /** Test seam; defaults to loadTenantIdentifierPatterns. */
  loadPatterns?: (scope: TenantScope, options: { signal: AbortSignal }) => Promise<TenantIdentifierPatterns>;
  /** Test seam; defaults to loadAttributeIdentifiers (TPL-04): the flagged attribute entries, null while the feed does not apply. */
  loadAttributeIdentifiers?: (scope: TenantScope, documentId: string, options: { signal: AbortSignal }) => Promise<AttributeIdentifierEntry[] | null>;
}

export interface IndexDocumentReport {
  chunksRead: number;
  tables: { profiles: number; rowsWritten: number; rowsDeleted: number; truncated: TableTruncation } | null;
  identifiers: { chunksIndexed: number; chunksWritten: number; documentIdentifiers: number; documentChanged: boolean; truncated: number; tenantPatterns: number; attributeEntries?: number } | null;
  warnings: IndexWarningCode[];
}

class IndexerUnavailable extends Error {
  constructor() {
    super('[Ingest] the writer has no lookup indexer methods');
    this.name = 'IndexerUnavailable';
  }
}

async function readChunks(input: IndexDocumentInput): Promise<IndexChunkRow[]> {
  const list = input.writer.listDocumentChunksForIndex;
  if (!list) throw new IndexerUnavailable();
  const chunks: IndexChunkRow[] = [];
  let after: string | null = null;
  for (;;) {
    input.signal.throwIfAborted();
    const page: IndexChunkRow[] = await list.call(input.writer, input.documentId, after, INDEX_PAGE_SIZE);
    chunks.push(...page);
    if (page.length < INDEX_PAGE_SIZE) return chunks;
    after = page[page.length - 1]?.id ?? null;
  }
}

function warn(code: IndexWarningCode, documentId: string, error: unknown): void {
  console.warn('[Ingest] lookup indexing failed; the document is published without it', {
    code,
    documentId,
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof IngestWriterError ? { rpc: error.rpc, sqlState: error.code } : {}),
  });
}

async function indexTables(input: IndexDocumentInput, chunks: readonly IndexChunkRow[]): Promise<NonNullable<IndexDocumentReport['tables']>> {
  const write = input.writer.writeTableRows;
  if (!write) throw new IndexerUnavailable();
  const parsed = parseTableRows(chunks.map((chunk) => ({ ...chunk, documentId: input.documentId })));
  // Every profile the document has chunks in is rewritten, so a re-index (backfill) also clears rows a table no longer has.
  const profileIds = [...new Set(chunks.map((chunk) => chunk.chunkingProfileId))].sort();
  let rowsWritten = 0;
  let rowsDeleted = 0;
  for (const profileId of profileIds) {
    input.signal.throwIfAborted();
    const rows = (parsed.profiles.get(profileId)?.rows ?? []).map((row) => ({
      table_key: row.tableKey,
      row_index: row.rowIndex,
      header: row.header,
      cells: row.cells,
      cell_tokens: row.cellTokens,
      cell_norm: row.cellNorm,
      chunk_ids: row.chunkIds,
    }));
    const result = await write.call(input.writer, input.documentId, profileId, rows);
    rowsWritten += result.rowsWritten;
    rowsDeleted += result.rowsDeleted;
  }
  return { profiles: parsed.profiles.size, rowsWritten, rowsDeleted, truncated: parsed.truncated };
}

async function indexIdentifiers(
  input: IndexDocumentInput,
  chunks: readonly IndexChunkRow[],
  patterns: TenantIdentifierPatterns,
  attributeEntries: readonly AttributeIdentifierEntry[] | null,
): Promise<NonNullable<IndexDocumentReport['identifiers']>> {
  const write = input.writer.writeChunkIdentifiers;
  if (!write) throw new IndexerUnavailable();
  const ordered = chunks
    .slice()
    .sort(
      (a, b) =>
        Number(a.chunkingProfileId !== 'legacy') - Number(b.chunkingProfileId !== 'legacy') ||
        a.chunkingProfileId.localeCompare(b.chunkingProfileId) ||
        a.chunkIndex - b.chunkIndex ||
        a.id.localeCompare(b.id),
    );
  const extracted: ChunkIdentifiers[] = ordered.map((chunk) => extractChunkIdentifiers(chunk.content, patterns.expressions));
  // TPL-04 (D-25): identifiers from flagged attributes join every chunk's own before the write, so the SQL union carries them too.
  const results = attributeEntries === null ? extracted : mergeAttributeIdentifiers(extracted, attributeEntries);
  const rows = ordered.map((chunk, position) => ({ chunkId: chunk.id, raw: results[position]!.raw, norm: results[position]!.norm }));
  let chunksWritten = 0;
  let documentChanged = false;
  for (let start = 0; start < rows.length; start += INDEX_PAGE_SIZE) {
    input.signal.throwIfAborted();
    const result = await write.call(input.writer, input.documentId, rows.slice(start, start + INDEX_PAGE_SIZE));
    chunksWritten += result.chunksWritten;
    documentChanged ||= result.documentChanged;
  }
  const union = unionIdentifiers(results);
  return {
    chunksIndexed: rows.length,
    chunksWritten,
    documentIdentifiers: union.norm.length,
    documentChanged,
    truncated: results.reduce((sum, result) => sum + result.truncated, 0) + union.truncated,
    tenantPatterns: patterns.expressions.length,
    ...(attributeEntries === null ? {} : { attributeEntries: attributeEntries.length }),
  };
}

/**
 * RET-12 and RET-15 storage (D-15, D-28, D-45): reads one document version's chunks of every chunking profile back by document id, then
 * writes its table rows and identifiers through the writer's tenant-bound RPCs. Used by the write stage and by the rag:table-rows and
 * rag:identifiers backfills. Never throws for an indexing failure (only when aborted): each failed part is logged once under [Ingest]
 * with its warning code and the error class, and returned in `warnings`. Logs carry counts, ids and error names only.
 */
export async function indexDocumentForLookup(input: IndexDocumentInput): Promise<IndexDocumentReport> {
  const report: IndexDocumentReport = { chunksRead: 0, tables: null, identifiers: null, warnings: [] };
  if (!input.tables && !input.identifiers) return report;

  let chunks: IndexChunkRow[];
  try {
    chunks = await readChunks(input);
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (input.tables) {
      warn('index_tables_failed', input.documentId, error);
      report.warnings.push('index_tables_failed');
    }
    if (input.identifiers) {
      warn('index_identifiers_failed', input.documentId, error);
      report.warnings.push('index_identifiers_failed');
    }
    return report;
  }
  report.chunksRead = chunks.length;

  if (input.tables) {
    try {
      report.tables = await indexTables(input, chunks);
    } catch (error) {
      if (input.signal.aborted) throw error;
      warn('index_tables_failed', input.documentId, error);
      report.warnings.push('index_tables_failed');
    }
  }

  if (input.identifiers) {
    try {
      const load = input.loadPatterns ?? loadTenantIdentifierPatterns;
      const patterns = await load(input.scope, { signal: input.signal });
      if (patterns.loadFailed) report.warnings.push('identifier_patterns_unavailable');
      const attributeEntries = await (input.loadAttributeIdentifiers ?? loadAttributeIdentifiers)(input.scope, input.documentId, { signal: input.signal });
      report.identifiers = await indexIdentifiers(input, chunks, patterns, attributeEntries);
    } catch (error) {
      if (input.signal.aborted) throw error;
      warn('index_identifiers_failed', input.documentId, error);
      report.warnings.push('index_identifiers_failed');
    }
  }
  return report;
}
