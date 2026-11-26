import { formatURLsForContext, type ExtractedURL } from '@/lib/url-extractor';
import { renderReferencedSection } from '../refs/resolve';
import type { InjectionMarks } from '../security/injection-check';
import { legacyKeepReason, legacyQueryTerms } from './relevance';
import { docsFromBlocks, wrapDocuments, type WrapDoc } from './wrap';
import type {
  CitationLabel,
  CitationLabeler,
  ContextBlock,
  KeptBy,
  KeptChunk,
  RagMode,
  ReferencedState,
  SourceImage,
  UsedDocument,
} from '../types';

export { normalizeQueryText } from './relevance';

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
  version?: number | null;
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
  /** When set, document sections render in this id order (unknown ids are ignored). */
  groupOrder?: string[];
  keptByOverride?: KeptBy;
  /** Renders a label before every non-image block; absent means the context is unchanged. */
  citationLabeler?: CitationLabeler;
  /** Chunk id to run key: consecutive rendered chunks of one document with the same key form one block. */
  blockRuns?: Map<string, string>;
  /** Chunk ids a rendered chunk stands for (a parent standing in for its children); defaults to its own id. */
  blockChunkIds?: Map<string, string[]>;
  /** RAG_CONTEXT_TAGGING: render the final blocks through wrapDocuments when there is at least one entry. */
  contextTagging?: boolean;
  /** Downweight: flagged chunks render after unflagged ones and their entries are marked flagged. */
  injectionMarks?: InjectionMarks | null;
  /** D-13: document id to its version line; a labelled document renders as its own section with the line before each entry. */
  versionLabels?: ReadonlyMap<string, string>;
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
  blocks: ContextBlock[];
}

export const NO_CONTEXT_TEXT = 'No relevant context found.';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];

export function filterCandidates<C extends AssemblyCandidate>(input: AssembleInput<C>): FilteredCandidates<C> {
  const { candidates, documents, chunkMetadata, applyRelevanceFilter } = input;
  const hasQuery = Boolean(input.queryText);
  const queryTerms = legacyQueryTerms(input.queryText);
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
      const reason = legacyKeepReason(
        { similarity: chunk.similarity, hasImage, filename: docMetadata.filename, text: docMetadata.content },
        queryTerms,
      );

      if (!applyRelevanceFilter || reason !== null) {
        const keptBy: KeptBy = reason ?? (hasImage ? 'image' : 'similarity');
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

type DraftBlock = Omit<ContextBlock, 'alias' | 'title'>;

function chunkMetadataOf(chunk: AssemblyCandidate, rows: Map<string, Record<string, any> | null>): Record<string, any> | undefined {
  let metadata = chunk.metadata ?? undefined;
  if (!metadata || !metadata.image_url) {
    const rowMetadata = rows.get(chunk.chunk_id);
    if (rowMetadata) metadata = { ...(metadata || {}), ...rowMetadata };
  }
  return metadata;
}

function pageOf(metadata: Record<string, any> | undefined): number | null {
  const page = metadata?.page_start ?? metadata?.page;
  return typeof page === 'number' && Number.isFinite(page) ? page : null;
}

function sectionPathOf(metadata: Record<string, any> | undefined): string[] | null {
  const path = metadata?.section_path;
  if (!Array.isArray(path)) return null;
  const parts = path.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.length > 0 ? parts : null;
}

export function blockTitle(block: Pick<ContextBlock, 'documentName' | 'page' | 'sectionPath'>): string {
  const page = block.page !== null ? `, p.${block.page}` : '';
  const section = block.sectionPath?.length ? ` / ${block.sectionPath.join(' > ')}` : '';
  return `${block.documentName}${page}${section}`;
}

/** Applies the labeler to non-image blocks in order, continuing the ordinal count. */
class BlockLabeller {
  readonly blocks: ContextBlock[] = [];
  private ordinal = 0;

  constructor(private readonly labeler: CitationLabeler | undefined) {}

  /** Block index to the label line written before it. */
  readonly headers = new Map<number, string>();

  /** Records the block; returns its label when a labeler is set and the block is not an image. */
  add(draft: DraftBlock): CitationLabel | null {
    const unlabelled = { ...draft, title: blockTitle(draft) };
    if (!this.labeler || draft.isImage) {
      this.blocks.push({ ...unlabelled, alias: null });
      return null;
    }
    this.ordinal += 1;
    const label = this.labeler(unlabelled, this.ordinal);
    this.headers.set(this.blocks.length, label.header);
    this.blocks.push({ ...unlabelled, text: label.text, alias: label.alias });
    return label;
  }
}

type WrapEntry = { block: number; reference: boolean; flagged: boolean } | { missing: string };

/** Entries in render order: blocks through docsFromBlocks, unreadable references as empty reference docs, then links. */
function wrapEntries(entries: readonly WrapEntry[], labeller: BlockLabeller, linksSection: string): WrapDoc[] {
  const referencedIndexes = new Set<number>();
  for (const entry of entries) if ('block' in entry && entry.reference) referencedIndexes.add(entry.block);
  const blockDocs = docsFromBlocks(labeller.blocks, { labels: labeller.headers, referencedIndexes });
  const docs: WrapDoc[] = [];
  let missing = 0;
  for (const entry of entries) {
    if ('missing' in entry) {
      missing += 1;
      docs.push({ id: `r${missing}`, kind: 'reference', source: entry.missing, text: '' });
      continue;
    }
    const doc = blockDocs[entry.block]!;
    docs.push(entry.flagged ? { ...doc, flagged: true } : doc);
  }
  if (docs.length > 0 && linksSection.trim()) docs.push({ id: 'links', kind: 'links', text: linksSection });
  return docs;
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

  const labeller = new BlockLabeller(input.citationLabeler);
  const marks = input.injectionMarks ?? null;
  const entries: WrapEntry[] = [];
  let context = filtered.referencedContext;
  const sections = input.referenced?.sections;
  if (sections?.length) {
    const rendered = sections.map((section, sectionIndex) => {
      if (section.missing) {
        entries.push({ missing: section.documentName });
        return renderReferencedSection(section);
      }
      entries.push({ block: labeller.blocks.length, reference: true, flagged: marks?.sectionIndexes.has(sectionIndex) ?? false });
      const label = labeller.add({
        documentId: section.documentId,
        documentName: section.documentName,
        documentVersion: null,
        chunkIds: [...section.chunkIds],
        page: null,
        sectionPath: null,
        text: section.text,
        isImage: false,
      });
      return label ? renderReferencedSection({ ...section, text: label.text }, label.header) : renderReferencedSection(section);
    });
    if (input.citationLabeler) context = rendered.join('');
  }
  let links: ExtractedURL[] = [];
  let linksSection = '';

  if (filtered.hasQuery && relevantChunks.length > 0) {
    const chunksByDocument = new Map<
      string,
      Array<{ content: string; similarity: number; chunkNum?: number; chunkId: string; documentId: string; metadata?: Record<string, any> }>
    >();
    const collectedURLs: ExtractedURL[] = [];
    // Sections group by file name; a version-labelled document groups by its id, so two versions of one file stay apart.
    const sectionNames = new Map<string, string>();
    const sectionKey = (documentId: string, docName: string): string => {
      if (!input.versionLabels?.has(documentId)) return docName;
      const key = `${docName}\u0000${documentId}`;
      sectionNames.set(key, docName);
      return key;
    };

    for (const chunk of relevantChunks) {
      const docInfo = docById.get(chunk.document_id);
      const docName = docInfo?.filename || docInfo?.name || 'Unknown Document';
      const groupKey = sectionKey(chunk.document_id, docName);

      const chunkMatch = chunk.content.match(/Chunk (\d+) of \d+/);
      const chunkNum = chunkMatch ? parseInt(chunkMatch[1]) : undefined;

      if (!chunksByDocument.has(groupKey)) {
        chunksByDocument.set(groupKey, []);
      }
      chunksByDocument.get(groupKey)!.push({
        content: chunk.content,
        similarity: chunk.similarity,
        chunkNum,
        chunkId: chunk.chunk_id,
        documentId: chunk.document_id,
        metadata: chunkMetadataOf(chunk, input.chunkMetadata),
      });

      const urls = input.chunkMetadata.get(chunk.chunk_id)?.urls;
      if (urls && Array.isArray(urls)) {
        collectedURLs.push(...urls);
      }
    }

    const contextParts: string[] = ['\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ==='];

    const docNameOrder: string[] = [];
    if (input.groupOrder?.length) {
      const idToName = new Map<string, string>();
      for (const chunk of relevantChunks) {
        const docInfo = docById.get(chunk.document_id);
        const name = sectionKey(chunk.document_id, docInfo?.filename || docInfo?.name || 'Unknown Document');
        if (!idToName.has(chunk.document_id)) idToName.set(chunk.document_id, name);
      }
      const seen = new Set<string>();
      for (const documentId of input.groupOrder) {
        const name = idToName.get(documentId);
        if (name && chunksByDocument.has(name) && !seen.has(name)) {
          docNameOrder.push(name);
          seen.add(name);
        }
      }
      for (const chunk of relevantChunks) {
        const docInfo = docById.get(chunk.document_id);
        const name = sectionKey(chunk.document_id, docInfo?.filename || docInfo?.name || 'Unknown Document');
        if (chunksByDocument.has(name) && !seen.has(name)) {
          docNameOrder.push(name);
          seen.add(name);
        }
      }
    } else {
      docNameOrder.push(...chunksByDocument.keys());
    }
    // A caller-supplied group order already places flagged groups (v2 keeps them out of the edge slots).
    if (marks && !input.groupOrder?.length) {
      const onlyFlagged = (name: string) => chunksByDocument.get(name)!.every((chunk) => marks.chunkIds.has(chunk.chunkId));
      const reordered = [...docNameOrder.filter((name) => !onlyFlagged(name)), ...docNameOrder.filter(onlyFlagged)];
      docNameOrder.splice(0, docNameOrder.length, ...reordered);
    }

    for (const docKey of docNameOrder) {
      const chunks = chunksByDocument.get(docKey);
      if (!chunks) continue;
      const docName = sectionNames.get(docKey) ?? docKey;
      const versionLine = sectionNames.has(docKey) ? input.versionLabels?.get(chunks[0]!.documentId) : undefined;
      const isImageDoc = IMAGE_EXTENSIONS.some((ext) => docName.toLowerCase().endsWith(ext));
      if (isImageDoc) continue;

      chunks.sort((a, b) => {
        if (marks) {
          const flaggedA = marks.chunkIds.has(a.chunkId);
          if (flaggedA !== marks.chunkIds.has(b.chunkId)) return flaggedA ? 1 : -1;
        }
        if (a.chunkNum && b.chunkNum) return a.chunkNum - b.chunkNum;
        return b.similarity - a.similarity;
      });

      contextParts.push(`\n--- Document: ${docName} (${chunks.length} relevant chunks) ---`);

      const pieces = chunks.map((c) => {
        const contentMatch = c.content.match(/^Document: [^.]+\.[^.]+\. Chunk \d+ of (\d+)\. Content: (.*)$/s);
        const actualContent = contentMatch ? contentMatch[2] : c.content;
        const gptForm = Boolean(input.isGPTModel && c.chunkNum);
        return {
          chunk: c,
          body: gptForm ? actualContent : c.content,
          rendered: gptForm ? `[Source: ${docName}]\n${actualContent}` : c.content,
          isImage: Boolean(c.metadata?.image_url),
          run: input.blockRuns?.get(c.chunkId),
        };
      });

      let start = 0;
      while (start < pieces.length) {
        const first = pieces[start]!;
        let end = start + 1;
        while (
          end < pieces.length &&
          !first.isImage &&
          first.run !== undefined &&
          !pieces[end]!.isImage &&
          pieces[end]!.run === first.run &&
          pieces[end]!.chunk.documentId === first.chunk.documentId
        ) {
          end += 1;
        }
        const group = pieces.slice(start, end);
        const documentVersion = input.documents.get(first.chunk.documentId)?.version;
        const draft: DraftBlock = {
          documentId: first.chunk.documentId,
          documentName: docName,
          documentVersion: typeof documentVersion === 'number' ? documentVersion : null,
          chunkIds: group.flatMap((piece) => input.blockChunkIds?.get(piece.chunk.chunkId) ?? [piece.chunk.chunkId]),
          page: group.map((piece) => pageOf(piece.chunk.metadata)).find((page) => page !== null) ?? null,
          sectionPath: sectionPathOf(first.chunk.metadata),
          text: group.map((piece) => piece.body).join('\n\n'),
          isImage: first.isImage,
        };
        entries.push({
          block: labeller.blocks.length,
          reference: false,
          flagged: marks !== null && draft.chunkIds.some((chunkId) => marks.chunkIds.has(chunkId)),
        });
        const label = labeller.add(draft);
        if (versionLine !== undefined && !draft.isImage) {
          // The line is written before the entry (and is the wrapped doc's header), never into the block text that citations quote.
          labeller.headers.set(labeller.blocks.length - 1, label ? `${versionLine}\n${label.header}` : versionLine);
          if (label) contextParts.push(`${versionLine}\n${label.header}\n${label.text}`);
          else contextParts.push(`${versionLine}\n${group.map((piece) => piece.rendered).join('\n\n')}`);
        } else if (label) contextParts.push(`${label.header}\n${label.text}`);
        else contextParts.push(...group.map((piece) => piece.rendered));
        start = end;
      }
    }
    contextParts.push('=== END OF RELEVANT INFORMATION ===\n');

    if (collectedURLs.length > 0) {
      const uniqueURLs = Array.from(new Map(collectedURLs.map((url) => [url.url, url])).values());
      links = uniqueURLs;
      const urlSection = formatURLsForContext(uniqueURLs);
      if (urlSection) {
        contextParts.push(urlSection);
        linksSection = urlSection;
      }
    }

    context += contextParts.join('\n\n');
  }

  if (input.contextTagging) {
    const wrapped = wrapDocuments(wrapEntries(entries, labeller, linksSection));
    if (wrapped !== null) context = wrapped;
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
      kept_by:
        input.keptByOverride ??
        filtered.chunkKeptBy.get(chunk.chunk_id) ??
        filtered.docKeptBy.get(chunk.document_id) ??
        'similarity',
    });
  });

  return { context, usedDocuments, relevantChunks, kept, queryTerms, sourceImages, links, refusalCandidate, blocks: labeller.blocks };
}

export function assembleContext<C extends AssemblyCandidate>(input: AssembleInput<C>): AssembleOutput<C> {
  return buildContext(filterCandidates(input), input);
}
