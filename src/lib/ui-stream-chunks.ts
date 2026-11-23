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

export function writeCustomChunk(writer: Pick<UIMessageStreamWriter, 'write'>, chunk: CustomChunk): void {
  writer.write(chunk as unknown as UIMessageChunk);
}

export interface DocumentSourceInput {
  id: string;
  name: string;
  filename: string;
  similarity?: number;
  matched_chunk?: string;
  chunk_text?: string;
}

export function buildDocumentSources(documents: DocumentSourceInput[]) {
  return documents.map(doc => ({
    id: doc.id,
    name: doc.name || doc.filename,
    similarity: doc.similarity,
    chunk_text: doc.chunk_text?.substring(0, 200) + '...'
  }));
}
