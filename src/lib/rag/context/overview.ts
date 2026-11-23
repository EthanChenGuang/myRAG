import type { SupabaseClient } from '@supabase/supabase-js';
import type { UsedDocument } from '../types';
import { NO_CONTEXT_TEXT, type AssemblyDocumentRow } from './assemble';

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
): OverviewContext {
  const chunksWithContent = rows.filter((chunk) => chunk.content && chunk.content.trim().length > 0);
  let context: string;

  if (chunksWithContent.length > 0) {
    const chunksByDocument = new Map<string, Array<{ content: string; similarity: number; chunkNum?: number }>>();

    for (const chunk of chunksWithContent) {
      const docName = documents.get(chunk.document_id)?.filename || UNKNOWN_DOCUMENT;
      const chunkMatch = chunk.content.match(/Chunk (\d+) of \d+/);
      const chunkNum = chunkMatch ? parseInt(chunkMatch[1]) : undefined;

      if (!chunksByDocument.has(docName)) chunksByDocument.set(docName, []);
      chunksByDocument.get(docName)!.push({ content: chunk.content, similarity: chunk.similarity, chunkNum });
    }

    const contextParts: string[] = [];
    for (const [docName, chunks] of chunksByDocument) {
      chunks.sort((a, b) => {
        if (a.chunkNum && b.chunkNum) return a.chunkNum - b.chunkNum;
        return b.similarity - a.similarity;
      });
      contextParts.push(`=== Document: ${docName} (${chunks.length} relevant chunks) ===`);
      contextParts.push(...chunks.map((chunk) => chunk.content));
    }
    context = contextParts.join('\n\n');
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

  return { context, usedDocuments };
}
