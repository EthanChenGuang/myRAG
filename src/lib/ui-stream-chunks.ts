import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';

export interface SourceImagesChunk {
  type: 'source_images';
  source_images: Array<{ name: string; size: number; type: string; url: string | undefined }>;
}

export interface UsedDocumentsChunk {
  type: 'metadata';
  usedDocuments: Array<Record<string, unknown>>;
}

export type CustomChunk = SourceImagesChunk | UsedDocumentsChunk;

/**
 * Writes one of the legacy custom stream chunks. They predate the data-part API and the frontend reads them by
 * `type` (`source_images`, `metadata`), so they must not be converted to `data-*` parts; the single cast below is
 * unavoidable because UIMessageChunk does not model them.
 */
export function writeCustomChunk(writer: Pick<UIMessageStreamWriter, 'write'>, chunk: CustomChunk): void {
  writer.write(chunk as unknown as UIMessageChunk);
}

export interface DocumentSourceInput {
  id: string;
  name: string;
  filename: string;
  similarity?: number;
  matched_chunk?: string;
}

export function buildDocumentSources(documents: DocumentSourceInput[]) {
  return documents.map(doc => ({
    id: doc.id,
    name: doc.name || doc.filename,
    similarity: doc.similarity,
    chunk_text: doc.matched_chunk ? `${doc.matched_chunk.substring(0, 200)}...` : undefined
  }));
}
