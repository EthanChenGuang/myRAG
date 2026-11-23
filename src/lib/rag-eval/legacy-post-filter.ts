import { formatURLsForContext, type ExtractedURL } from '@/lib/url-extractor';

export type LegacyKeptBy = 'similarity' | 'name' | 'image';
export type LegacyRagMode = 'strict' | 'balanced' | 'flexible';

export interface LegacyCandidate {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown> | null;
}

export interface LegacyDocumentRow {
  id: string;
  filename: string;
  created_at?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface LegacyPostFilterInput {
  queryText: string;
  candidates: LegacyCandidate[];
  documents: Map<string, LegacyDocumentRow>;
  chunkMetadata: Map<string, Record<string, unknown> | null>;
  chunkUrlMetadata: Map<string, Record<string, unknown> | null>;
  isGPTModel: boolean;
  ragMode: LegacyRagMode;
  webSearchEnabled: boolean;
}

export interface LegacyKeptChunk {
  chunk_id: string;
  document_id: string;
  document_name: string;
  content: string;
  similarity: number;
  rank: number;
  kept_by: LegacyKeptBy;
}

export interface LegacyUsedDocument {
  document_id: string;
  name: string;
  similarity: number | null;
  image_url: string | null;
}

export interface LegacyPostFilterResult {
  queryTerms: string[];
  kept: LegacyKeptChunk[];
  usedDocuments: LegacyUsedDocument[];
  context: string;
  refused: boolean;
  refusalReason: 'no_relevant_context' | null;
}

const NO_CONTEXT = 'No relevant context found.';
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

export function legacyQueryTerms(queryText: string): string[] {
  return queryText
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 3)
    .map((term) => term.replace(/[^a-z0-9]/g, ''));
}

interface WorkingDocument {
  id: string;
  name: string;
  similarity?: number;
  image_url?: string;
  keptBy: LegacyKeptBy;
}

export function applyLegacyPostFilter(input: LegacyPostFilterInput): LegacyPostFilterResult {
  const { queryText, candidates, documents, chunkMetadata, chunkUrlMetadata, isGPTModel, ragMode, webSearchEnabled } = input;
  const queryTerms = legacyQueryTerms(queryText);

  const usedDocuments: WorkingDocument[] = [];
  const chunkKeptBy = new Map<string, LegacyKeptBy>();

  // Filter 1
  for (const chunk of candidates) {
    const docMetadata = documents.get(chunk.document_id);
    if (!docMetadata) continue;

    let metadata = chunk.metadata ?? undefined;
    if (!metadata || !metadata.image_url) {
      const chunkData = chunkMetadata.get(chunk.chunk_id);
      if (chunkData) {
        metadata = { ...(metadata || {}), ...chunkData };
      }
    }

    const imageUrl = metadata?.image_url ? String(metadata.image_url) : undefined;
    const hasImage = !!imageUrl;
    const docName = docMetadata.filename.toLowerCase();
    const isRelevantByName = queryTerms.some(
      (term) => docName.includes(term) || (docMetadata.content && docMetadata.content.toLowerCase().includes(term)),
    );

    if (chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {
      const keptBy: LegacyKeptBy = chunk.similarity > 0.65 ? 'similarity' : isRelevantByName ? 'name' : 'image';
      chunkKeptBy.set(chunk.chunk_id, keptBy);
      const existingDoc = usedDocuments.find((doc) => doc.id === chunk.document_id);
      if (!existingDoc) {
        usedDocuments.push({
          id: chunk.document_id,
          name: docMetadata.filename,
          similarity: chunk.similarity,
          image_url: imageUrl,
          keptBy,
        });
      } else if (!existingDoc.similarity || chunk.similarity > existingDoc.similarity) {
        existingDoc.similarity = chunk.similarity;
      }
    }
  }

  const relevantChunks = candidates.filter((chunk) => usedDocuments.some((doc) => doc.id === chunk.document_id));

  let context = '';
  if (relevantChunks.length > 0) {
    const chunksByDocument = new Map<string, Array<{ content: string; similarity: number; chunkNum?: number }>>();
    const collectedURLs: ExtractedURL[] = [];

    for (const chunk of relevantChunks) {
      const docInfo = usedDocuments.find((doc) => doc.id === chunk.document_id);
      const docName = docInfo?.name || 'Unknown Document';

      const chunkMatch = chunk.content.match(/Chunk (\d+) of \d+/);
      const chunkNum = chunkMatch ? parseInt(chunkMatch[1]) : undefined;

      if (!chunksByDocument.has(docName)) {
        chunksByDocument.set(docName, []);
      }
      chunksByDocument.get(docName)!.push({ content: chunk.content, similarity: chunk.similarity, chunkNum });

      const urls = chunkUrlMetadata.get(chunk.chunk_id)?.urls;
      if (urls && Array.isArray(urls)) {
        collectedURLs.push(...(urls as ExtractedURL[]));
      }
    }

    const contextParts: string[] = ['\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ==='];

    for (const [docName, chunks] of chunksByDocument) {
      const isImageDoc = IMAGE_EXTENSIONS.some((ext) => docName.toLowerCase().endsWith(ext));
      if (isImageDoc) continue;

      chunks.sort((a, b) => {
        if (a.chunkNum && b.chunkNum) return a.chunkNum - b.chunkNum;
        return b.similarity - a.similarity;
      });

      contextParts.push(`\n--- Document: ${docName} (${chunks.length} relevant chunks) ---`);

      const formattedChunks = chunks.map((c) => {
        const contentMatch = c.content.match(/^Document: [^.]+\.[^.]+\. Chunk \d+ of (\d+)\. Content: (.*)$/s);
        const actualContent = contentMatch ? contentMatch[2] : c.content;

        if (isGPTModel && c.chunkNum) {
          return `[Source: ${docName}]\n${actualContent}`;
        }
        return c.content;
      });

      contextParts.push(...formattedChunks);
    }
    contextParts.push('=== END OF RELEVANT INFORMATION ===\n');

    if (collectedURLs.length > 0) {
      const uniqueURLs = Array.from(new Map(collectedURLs.map((url) => [url.url, url])).values());
      const urlSection = formatURLsForContext(uniqueURLs);
      if (urlSection) {
        contextParts.push(urlSection);
      }
    }

    context += contextParts.join('\n\n');
  }

  if (!context.trim()) {
    context = NO_CONTEXT;
  }

  // Filter 2
  const filteredDocuments = usedDocuments.filter((doc) => {
    if (doc.similarity && (doc.similarity >= 0.6 || (doc.image_url && doc.similarity > 0.25))) {
      return true;
    }
    const docName = (doc.name || '').toLowerCase();
    return queryTerms.some((term) => term.length > 3 && docName.includes(term));
  });

  const refused =
    ragMode === 'strict' &&
    !webSearchEnabled &&
    filteredDocuments.length === 0 &&
    context.trim().toLowerCase().startsWith('no relevant context found');

  const docKeptBy = new Map(usedDocuments.map((doc) => [doc.id, doc.keptBy] as const));
  const kept: LegacyKeptChunk[] = [];
  candidates.forEach((chunk, index) => {
    const doc = usedDocuments.find((d) => d.id === chunk.document_id);
    if (!doc) return;
    kept.push({
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      document_name: doc.name,
      content: chunk.content,
      similarity: chunk.similarity,
      rank: index + 1,
      kept_by: chunkKeptBy.get(chunk.chunk_id) ?? docKeptBy.get(chunk.document_id) ?? 'similarity',
    });
  });

  return {
    queryTerms,
    kept,
    usedDocuments: filteredDocuments.map((doc) => ({
      document_id: doc.id,
      name: doc.name,
      similarity: doc.similarity ?? null,
      image_url: doc.image_url ?? null,
    })),
    context,
    refused,
    refusalReason: refused ? 'no_relevant_context' : null,
  };
}
