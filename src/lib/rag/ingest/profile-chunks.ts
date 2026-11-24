import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { LEXICAL_VERSION, chunkLexicalText } from '../lexical/chunk-text';
import type { ChunkerConfig } from './chunkers';
import { chunkParentChild } from './chunkers/parent-child';
import { contentHash } from './hash';
import { buildEmbeddingText, EMBEDDING_TEXT_VERSION } from './text/embedding-text';
import type {
  ChunkingProfileRow,
  IngestWriter,
  ProfileChildWrite,
  ProfileParentWrite,
  ProfileVectors,
  WriteProfileChunksResult,
} from './writer';

export type { ChunkingProfileRow, ProfileChildWrite, ProfileParentWrite };

/** What building a profile's chunks needs of the document: its name, the processing profile's chunker and the embedding header line. */
export interface ProfileDocument {
  filename: string;
  /** The chunker of the document's processing profile; its kind and clause data decide how parents are cut. */
  chunker: ChunkerConfig;
  templateHeader?: string;
}

export interface BuiltProfileChunks {
  /** Parents are stored as they are cut: no lexical text and no embedding. */
  parents: ProfileParentWrite[];
  /** Only children are indexed: each carries lexical_text, and embeddingTexts[i] is the text to embed for children[i]. */
  children: ProfileChildWrite[];
  embeddingTexts: string[];
  warnings: string[];
}

/** The live non-legacy profiles (building, ready or active) grouped by the doc type they belong to. Retired profiles and `legacy` are left out. */
export function liveProfilesByDocType(rows: readonly ChunkingProfileRow[]): Map<string, ChunkingProfileRow[]> {
  const grouped = new Map<string, ChunkingProfileRow[]>();
  for (const row of rows) {
    if (row.id === 'legacy' || row.status === 'retired') continue;
    const list = grouped.get(row.docType);
    if (list) list.push(row);
    else grouped.set(row.docType, [row]);
  }
  return grouped;
}

/**
 * Cuts the parse Markdown into the parents and children of a chunking profile (D-20). Children get lexical_text (chunkLexicalText), the
 * normalised content hash, URL metadata and the lexical version, like the chunks of the legacy path, and the text to embed from the Phase 3
 * builder. Pure: nothing is read or written.
 */
export function buildProfileChunks(document: ProfileDocument, parseMarkdown: string, profile: ChunkingProfileRow): BuiltProfileChunks {
  const cut = chunkParentChild(
    parseMarkdown,
    { childTokens: profile.childTokens, parentMode: profile.parentMode, parentTokens: profile.parentTokens },
    document.chunker,
  );
  const parents: ProfileParentWrite[] = cut.parents.map((parent) => ({
    parent_index: parent.parent_index,
    section_path: parent.section_path,
    content: parent.content,
    token_count: parent.token_count,
  }));
  const embeddingTexts: string[] = [];
  const children = cut.children.map((child, index): ProfileChildWrite => {
    embeddingTexts.push(buildEmbeddingText({ section_path: child.section_path, content: child.content, template_header: document.templateHeader }));
    return {
      content: child.content,
      chunk_index: index,
      parent_index: child.parent_index,
      section_path: child.section_path,
      chunk_kind: child.chunk_kind,
      embedding_text_version: EMBEDDING_TEXT_VERSION,
      page_start: child.page_start,
      page_end: child.page_end,
      content_hash: contentHash(child.content),
      lexical_text: chunkLexicalText({
        sectionPath: child.section_path,
        content: child.content,
        chunkKind: child.chunk_kind,
        metadata: child.metadata,
        documentFilename: document.filename,
      }),
      metadata: {
        ...(enrichChunkWithURLs(child.content, child.metadata) as Record<string, unknown>),
        document_title: document.filename,
        chunk_index: index,
        chunk_position: index + 1,
        total_chunks: cut.children.length,
        lexical_version: LEXICAL_VERSION,
      },
    };
  });
  return { parents, children, embeddingTexts, warnings: cut.warnings };
}

/**
 * Writes one profile's parents, children and vectors through the ingest writer in one call, which the database applies in one transaction
 * for the writer's tenant. The writer is the only caller of the rag_* writer functions.
 */
export function writeProfileChunks(
  writer: Pick<IngestWriter, 'writeProfileChunks'>,
  documentId: string,
  profileId: string,
  built: BuiltProfileChunks,
  embeddings: Record<string, ProfileVectors> | null,
): Promise<WriteProfileChunksResult> {
  return writer.writeProfileChunks(documentId, { profileId, parents: built.parents, children: built.children, embeddings });
}
