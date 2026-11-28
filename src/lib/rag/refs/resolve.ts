import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { tenantPredicate, type TenantPredicate, type TenantScope } from '../tenant/scope';
import type { DocumentPartRef, ReferencedSection, ReferencedState, UsedDocument } from '../types';

export interface ResolveDocumentRefsInput {
  scope: TenantScope;
  mentions: string[];
  documentParts: DocumentPartRef[];
  admin: SupabaseClient;
  signal: AbortSignal;
}

export interface ResolvedDocumentRefs extends ReferencedState {
  sections: ReferencedSection[];
  ignored: number;
}

const REFERENCE_CHUNK_LIMIT = 30;
const PREVIEW_LENGTH = 200;

interface Scopable {
  eq(column: string, value: string | boolean): Scopable;
  is(column: string, value: null): Scopable;
}

/**
 * Every documents query goes through here so the tenant predicate and the D-08 filter cannot be left off:
 * only a current, ready version is ever read, so a quarantined or superseded document is not referenced.
 */
function scoped<T>(query: T, predicate: TenantPredicate): T {
  const filter = (query as unknown as Scopable).eq('is_current', true).eq('status', 'ready');
  if (predicate.kind === 'org') return filter.eq('organization_id', predicate.organizationId) as unknown as T;
  if (predicate.kind === 'personal') return filter.eq('user_id', predicate.userId).is('organization_id', null) as unknown as T;
  return filter as unknown as T;
}

interface CurrentChunks {
  eq(column: string, value: unknown): CurrentChunks;
}

/** Chunk reads of a referenced document stop at the same line: current and ready only. */
function currentChunks<T>(query: T): T {
  return (query as unknown as CurrentChunks).eq('is_current', true).eq('status', 'ready') as unknown as T;
}

interface DocumentRef {
  id: string;
  name: string;
}

/** Renders one referenced section; with a header (a citation label) it goes on its own line before the text. */
export function renderReferencedSection(section: ReferencedSection, header?: string): string {
  if (section.missing) return `\n\nDocument "${section.documentName}" was referenced but no content could be retrieved.\n`;
  const body = header === undefined ? section.text : `${header}\n${section.text}`;
  return `\n\n=== DOCUMENT: "${section.documentName}" ===\n${body}\n=== END OF DOCUMENT ===\n`;
}

interface ChunkText {
  id?: string | null;
  content: string;
}

function chunkSection(docRef: DocumentRef, chunks: ChunkText[]): ReferencedSection {
  return {
    documentId: docRef.id,
    documentName: docRef.name,
    chunkIds: chunks.map((chunk) => chunk.id).filter((id): id is string => typeof id === 'string'),
    text: chunks.map((chunk) => chunk.content).join('\n\n'),
  };
}

export async function resolveDocumentRefs(input: ResolveDocumentRefsInput): Promise<ResolvedDocumentRefs> {
  const { scope, mentions, documentParts, admin, signal } = input;
  const predicate = tenantPredicate(scope);

  const mentionRefs: DocumentRef[] = [];
  for (const docName of mentions) {
    logger.db('[Document Search] Resolving document mention', { mentionLength: docName.length });

    const { data: docs, error } = await scoped(
      admin.from('documents').select('id, filename').ilike('filename', `%${docName}%`).limit(1),
      predicate,
    ).abortSignal(signal);

    if (!error && docs && docs.length > 0) {
      mentionRefs.push({ id: docs[0].id, name: docs[0].filename });
      continue;
    }

    const { data: exactDocs, error: exactError } = await scoped(
      admin.from('documents').select('id, filename').eq('filename', docName).limit(1),
      predicate,
    ).abortSignal(signal);

    if (!exactError && exactDocs && exactDocs.length > 0) {
      mentionRefs.push({ id: exactDocs[0].id, name: exactDocs[0].filename });
    } else {
      logger.db('[Document Search] No document found for mention in the caller scope', { mentionLength: docName.length });
    }
  }

  const references: DocumentRef[] = [...mentionRefs, ...documentParts.map((part) => ({ id: part.id, name: part.name }))];
  const usedDocuments: UsedDocument[] = [];
  const sections: ReferencedSection[] = [];
  let ignored = 0;

  for (const docRef of references) {
    const { data: docMetadata, error: metadataError } = await scoped(
      admin.from('documents').select('id, filename, created_at, content, metadata').eq('id', docRef.id),
      predicate,
    )
      .abortSignal(signal)
      .single();

    if (metadataError || !docMetadata) {
      ignored += 1;
      continue;
    }

    usedDocuments.push({
      id: docRef.id,
      name: docRef.name,
      filename: docMetadata.filename,
      created_at: docMetadata.created_at,
      content_preview: docMetadata.content ? docMetadata.content.substring(0, PREVIEW_LENGTH) + '...' : undefined,
      explicitly_referenced: true,
      external_url: docMetadata.metadata?.external_url,
    });

    const { data: chunks, error } = await currentChunks(admin.from('document_chunks').select('id, content').eq('document_id', docRef.id))
      .limit(REFERENCE_CHUNK_LIMIT)
      .abortSignal(signal);

    if (error) {
      console.error(`Error fetching chunks for document ${docRef.id}:`, error);
      continue;
    }

    if (chunks && chunks.length > 0) {
      sections.push(chunkSection(docRef, chunks as ChunkText[]));
      continue;
    }

    const { data: docData, error: docError } = await scoped(
      admin.from('documents').select('content, text').eq('id', docRef.id),
      predicate,
    )
      .abortSignal(signal)
      .single();

    if (!docError && docData) {
      const fullText = docData.text || docData.content || '';
      if (fullText) sections.push({ documentId: docRef.id, documentName: docRef.name, chunkIds: [], text: fullText });
      continue;
    }

    const { data: allChunks, error: allChunksError } = await currentChunks(admin.from('document_chunks').select('*').eq('document_id', docRef.id))
      .limit(REFERENCE_CHUNK_LIMIT)
      .abortSignal(signal);

    if (!allChunksError && allChunks && allChunks.length > 0) {
      sections.push(chunkSection(docRef, allChunks as ChunkText[]));
    } else {
      sections.push({ documentId: docRef.id, documentName: docRef.name, chunkIds: [], text: '', missing: true });
    }
  }

  if (ignored > 0) {
    console.warn('[RAG Tenant] Ignored document references outside the caller scope', { ignoredReferences: ignored });
  }

  const context = sections.map((section) => renderReferencedSection(section)).join('');
  return { usedDocuments, context, sections, ignored };
}
