import { formatURLsForContext, type ExtractedURL } from '@/lib/url-extractor';
import type { KeptBy, KeptChunk, RagMode, ReferencedState, SourceImage, UsedDocument } from '../types';

export interface AssemblyCandidate {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, any> | null;
}

export interface AssemblyDocumentRow {
  id: string;
  filename: string;
  created_at?: string | null;
  content?: string | null;
  metadata?: Record<string, any> | null;
}

export interface AssembleInput<C extends AssemblyCandidate = AssemblyCandidate> {
  queryText: unknown;
  candidates: C[];
  documents: Map<string, AssemblyDocumentRow>;
  chunkMetadata: Map<string, Record<string, any> | null>;
  referenced: ReferencedState | null;
  isGPTModel: boolean;
  ragMode: RagMode;
  webSearchEnabled: boolean;
  applyRelevanceFilter: boolean;
}

export interface FilteredCandidates<C extends AssemblyCandidate = AssemblyCandidate> {
  hasQuery: boolean;
  queryTerms: string[];
  usedDocuments: UsedDocument[];
  relevantChunks: C[];
  referencedContext: string;
  chunkKeptBy: Map<string, KeptBy>;
  docKeptBy: Map<string, KeptBy>;
  applyRelevanceFilter: boolean;
}

export interface AssembleOutput<C extends AssemblyCandidate = AssemblyCandidate> {
  context: string;
  usedDocuments: UsedDocument[];
  relevantChunks: C[];
  kept: KeptChunk[];
  queryTerms: string[];
  sourceImages: SourceImage[];
  links: ExtractedURL[];
  refusalCandidate: boolean;
}

export const NO_CONTEXT_TEXT = 'No relevant context found.';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

export function normalizeQueryText(input: unknown): string {
  if (typeof input === 'string') {
    return input.toLowerCase();
  }
  if (Array.isArray(input) && input.length > 0) {
    const textPart = input.find((part) => part.type === 'text');
    return textPart && typeof textPart.text === 'string' ? textPart.text.toLowerCase() : '';
  }
  return '';
}

function queryTermsOf(queryText: unknown): string[] {
  return normalizeQueryText(queryText)
    .split(/\s+/)
    .filter((term) => term.length > 3)
    .map((term) => term.replace(/[^a-z0-9]/g, ''));
}

export function filterCandidates<C extends AssemblyCandidate>(input: AssembleInput<C>): FilteredCandidates<C> {
  const { candidates, documents, chunkMetadata, applyRelevanceFilter } = input;
  const hasQuery = Boolean(input.queryText);
  const queryTerms = queryTermsOf(input.queryText);
  const usedDocuments: UsedDocument[] = (input.referenced?.usedDocuments ?? []).map((doc) => ({ ...doc }));
  const chunkKeptBy = new Map<string, KeptBy>();
  const docKeptBy = new Map<string, KeptBy>();

  if (hasQuery) {
    for (const chunk of candidates) {
      const docMetadata = documents.get(chunk.document_id);
      if (!docMetadata) continue;

      let metadata = chunk.metadata ?? undefined;
      if (!metadata || !metadata.image_url) {
        const rowMetadata = chunkMetadata.get(chunk.chunk_id);
        if (rowMetadata) {
          metadata = { ...(metadata || {}), ...rowMetadata };
        }
      }

      const hasImage = !!metadata?.image_url;
      const docName = docMetadata.filename.toLowerCase();
      const isRelevantByName = queryTerms.some(
        (term) => docName.includes(term) || (docMetadata.content && docMetadata.content.toLowerCase().includes(term)),
      );

      if (!applyRelevanceFilter || chunk.similarity > 0.65 || isRelevantByName || (hasImage && chunk.similarity > 0.25)) {
        const keptBy: KeptBy = chunk.similarity > 0.65 ? 'similarity' : isRelevantByName ? 'name' : hasImage ? 'image' : 'similarity';
        chunkKeptBy.set(chunk.chunk_id, keptBy);
        const existingDoc = usedDocuments.find((doc) => doc.id === chunk.document_id);
        if (!existingDoc) {
          usedDocuments.push({
            id: chunk.document_id,
            name: docMetadata.filename,
            filename: docMetadata.filename,
            created_at: docMetadata.created_at as string | undefined,
            content_preview: docMetadata.content ? docMetadata.content.substring(0, 200) + '...' : undefined,
            similarity: chunk.similarity,
            matched_chunk: chunk.content.substring(0, 150) + '...',
            explicitly_referenced: false,
            image_url: metadata?.image_url,
            external_url: docMetadata.metadata?.external_url,
          });
          docKeptBy.set(chunk.document_id, keptBy);
        } else {
          // A document with text and picture chunks (a PDF with figures) is one used document: the first picture chunk kept, in rank order, gives it the image.
          if (!existingDoc.image_url && metadata?.image_url) existingDoc.image_url = metadata.image_url;
          if (!existingDoc.similarity || chunk.similarity > existingDoc.similarity) {
            existingDoc.similarity = chunk.similarity;
            existingDoc.matched_chunk = chunk.content.substring(0, 150) + '...';
          }
        }
      }
    }
  }

  const usedIds = new Set(usedDocuments.map((doc) => doc.id));
  const relevantChunks = candidates.filter((chunk) => usedIds.has(chunk.document_id));

  return {
    hasQuery,
    queryTerms,
    usedDocuments,
    relevantChunks,
    referencedContext: input.referenced?.context ?? '',
    chunkKeptBy,
    docKeptBy,
    applyRelevanceFilter,
  };
}

export function buildContext<C extends AssemblyCandidate>(
  filtered: FilteredCandidates<C>,
  input: AssembleInput<C>,
): AssembleOutput<C> {
  const { queryTerms, relevantChunks, applyRelevanceFilter } = filtered;
  const docById = new Map<string, UsedDocument>();
  for (const doc of filtered.usedDocuments) {
    if (!docById.has(doc.id)) docById.set(doc.id, doc);
  }

  let context = filtered.referencedContext;
  let links: ExtractedURL[] = [];

  if (filtered.hasQuery && relevantChunks.length > 0) {
    const chunksByDocument = new Map<string, Array<{ content: string; similarity: number; chunkNum?: number }>>();
    const collectedURLs: ExtractedURL[] = [];

    for (const chunk of relevantChunks) {
      const docInfo = docById.get(chunk.document_id);
      const docName = docInfo?.filename || docInfo?.name || 'Unknown Document';

      const chunkMatch = chunk.content.match(/Chunk (\d+) of \d+/);
      const chunkNum = chunkMatch ? parseInt(chunkMatch[1]) : undefined;

      if (!chunksByDocument.has(docName)) {
        chunksByDocument.set(docName, []);
      }
      chunksByDocument.get(docName)!.push({ content: chunk.content, similarity: chunk.similarity, chunkNum });

      const urls = input.chunkMetadata.get(chunk.chunk_id)?.urls;
      if (urls && Array.isArray(urls)) {
        collectedURLs.push(...urls);
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

        if (input.isGPTModel && c.chunkNum) {
          return `[Source: ${docName}]\n${actualContent}`;
        }
        return c.content;
      });

      contextParts.push(...formattedChunks);
    }
    contextParts.push('=== END OF RELEVANT INFORMATION ===\n');

    if (collectedURLs.length > 0) {
      const uniqueURLs = Array.from(new Map(collectedURLs.map((url) => [url.url, url])).values());
      links = uniqueURLs;
      const urlSection = formatURLsForContext(uniqueURLs);
      if (urlSection) {
        contextParts.push(urlSection);
      }
    }

    context += contextParts.join('\n\n');
  }

  if (!context.trim()) {
    context = NO_CONTEXT_TEXT;
  }

  const usedDocuments = applyRelevanceFilter
    ? filtered.usedDocuments.filter((doc) => {
        if (doc.explicitly_referenced) return true;
        if (doc.similarity && (doc.similarity >= 0.6 || (doc.image_url && doc.similarity > 0.25))) return true;
        const docName = (doc.name || doc.filename || '').toLowerCase();
        return queryTerms.some((term) => term.length > 3 && docName.includes(term));
      })
    : filtered.usedDocuments;

  const sourceImages: SourceImage[] = usedDocuments
    .filter((doc) => doc.image_url)
    .map((doc) => ({
      name: doc.name || doc.filename || 'Source Image',
      size: 0,
      type: 'image/jpeg',
      url: doc.image_url,
    }));

  const refusalCandidate =
    input.ragMode === 'strict' &&
    !input.webSearchEnabled &&
    usedDocuments.length === 0 &&
    context.trim().toLowerCase().startsWith('no relevant context found');

  const kept: KeptChunk[] = [];
  input.candidates.forEach((chunk, index) => {
    const doc = docById.get(chunk.document_id);
    if (!doc) return;
    kept.push({
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      document_name: doc.name,
      content: chunk.content,
      similarity: chunk.similarity,
      rank: index + 1,
      kept_by: filtered.chunkKeptBy.get(chunk.chunk_id) ?? filtered.docKeptBy.get(chunk.document_id) ?? 'similarity',
    });
  });

  return { context, usedDocuments, relevantChunks, kept, queryTerms, sourceImages, links, refusalCandidate };
}

export function assembleContext<C extends AssemblyCandidate>(input: AssembleInput<C>): AssembleOutput<C> {
  return buildContext(filterCandidates(input), input);
}
