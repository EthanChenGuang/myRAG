import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContextBlock, UsedDocument } from '../types';
import { NO_CONTEXT_TEXT, type AssemblyDocumentRow } from './assemble';
import { docsFromBlocks, wrapDocuments } from './wrap';

export const OVERVIEW_QUERY = 'general information overview';
export const OVERVIEW_MATCH_COUNT = 5;
export const OVERVIEW_SIMILARITY_THRESHOLD = 0.5;

export interface OverviewChunk {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
}

export interface OverviewContext {
  context: string;
  usedDocuments: UsedDocument[];
  /** One block per document group in render order; absent when no chunk has content. */
  blocks?: ContextBlock[];
}

export interface OverviewAssembleOptions {
  /** Renders the blocks through wrapDocuments instead of the `=== Document:` string. */
  contextTagging?: boolean;
  /** Downweighted chunks: rendered after the unflagged chunks of their document, all-flagged documents last. */
  flaggedChunkIds?: ReadonlySet<string>;
}

const UNKNOWN_DOCUMENT = 'Unknown Document';
const PREVIEW_LENGTH = 200;
const MATCHED_CHUNK_LENGTH = 150;

export async function fetchOverviewDocuments(
  chunks: OverviewChunk[],
  options: { admin: SupabaseClient; signal: AbortSignal },
): Promise<Map<string, AssemblyDocumentRow>> {
  const documents = new Map<string, AssemblyDocumentRow>();
  const ids = Array.from(new Set(chunks.map((chunk) => chunk.document_id)));
  if (ids.length === 0) return documents;

  const result = await options.admin
    .from('documents')
    .select('id, filename, created_at, content, metadata')
    .in('id', ids)
    .eq('is_current', true)
    .eq('status', 'ready')
    .abortSignal(options.signal);
  options.signal.throwIfAborted();
  if (result.error) throw new Error(`[RAG Overview] documents lookup failed: ${result.error.message}`);

  for (const row of (result.data ?? []) as AssemblyDocumentRow[]) documents.set(row.id, row);
  return documents;
}

/** The general-overview context: chunks grouped by document name, ordered by chunk number when both carry one, else by similarity. */
export function assembleOverviewContext(
  rows: OverviewChunk[],
  documents: Map<string, AssemblyDocumentRow>,
  referenced: UsedDocument[] = [],
  options: OverviewAssembleOptions = {},
): OverviewContext {
  const chunksWithContent = rows.filter((chunk) => chunk.content && chunk.content.trim().length > 0);
  const flagged = options.flaggedChunkIds && options.flaggedChunkIds.size > 0 ? options.flaggedChunkIds : null;
  let context: string;
  let blocks: ContextBlock[] | undefined;

  if (chunksWithContent.length > 0) {
    type GroupChunk = { chunkId: string; documentId: string; content: string; similarity: number; chunkNum?: number };
    const chunksByDocument = new Map<string, GroupChunk[]>();

    for (const chunk of chunksWithContent) {
      const docName = documents.get(chunk.document_id)?.filename || UNKNOWN_DOCUMENT;
      const chunkMatch = chunk.content.match(/Chunk (\d+) of \d+/);
      const chunkNum = chunkMatch ? parseInt(chunkMatch[1]) : undefined;

      if (!chunksByDocument.has(docName)) chunksByDocument.set(docName, []);
      chunksByDocument
        .get(docName)!
        .push({ chunkId: chunk.chunk_id, documentId: chunk.document_id, content: chunk.content, similarity: chunk.similarity, chunkNum });
    }

    let groups = [...chunksByDocument];
    for (const [, chunks] of groups) {
      chunks.sort((a, b) => {
        if (a.chunkNum && b.chunkNum) return a.chunkNum - b.chunkNum;
        return b.similarity - a.similarity;
      });
      if (flagged) chunks.sort((a, b) => Number(flagged.has(a.chunkId)) - Number(flagged.has(b.chunkId)));
    }
    if (flagged) {
      const allFlagged = ([, chunks]: [string, GroupChunk[]]) => Number(chunks.every((chunk) => flagged.has(chunk.chunkId)));
      groups = groups.sort((a, b) => allFlagged(a) - allFlagged(b));
    }

    const contextParts: string[] = [];
    blocks = [];
    for (const [docName, chunks] of groups) {
      contextParts.push(`=== Document: ${docName} (${chunks.length} relevant chunks) ===`);
      contextParts.push(...chunks.map((chunk) => chunk.content));
      blocks.push({
        documentId: chunks[0]!.documentId,
        documentName: docName,
        documentVersion: null,
        chunkIds: chunks.map((chunk) => chunk.chunkId),
        page: null,
        sectionPath: null,
        title: docName,
        text: chunks.map((chunk) => chunk.content).join('\n\n'),
        isImage: false,
        alias: null,
      });
    }
    context = options.contextTagging
      ? (wrapDocuments(docsFromBlocks(blocks, flagged ? { flaggedChunkIds: flagged } : {})) ?? NO_CONTEXT_TEXT)
      : contextParts.join('\n\n');
  } else {
    context = NO_CONTEXT_TEXT;
  }

  const usedDocuments: UsedDocument[] = referenced.map((doc) => ({ ...doc }));
  for (const chunk of rows) {
    if (usedDocuments.some((doc) => doc.id === chunk.document_id)) continue;
    const row = documents.get(chunk.document_id);
    if (!row) continue;
    usedDocuments.push({
      id: chunk.document_id,
      name: row.filename,
      filename: row.filename,
      created_at: row.created_at ?? undefined,
      content_preview: row.content ? row.content.substring(0, PREVIEW_LENGTH) + '...' : undefined,
      similarity: chunk.similarity,
      matched_chunk: (chunk.content ?? '').substring(0, MATCHED_CHUNK_LENGTH) + '...',
      external_url: row.metadata?.external_url,
    });
  }

  return blocks ? { context, usedDocuments, blocks } : { context, usedDocuments };
}
