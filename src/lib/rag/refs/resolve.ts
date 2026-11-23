import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { tenantPredicate, type TenantPredicate, type TenantScope } from '../tenant/scope';
import type { DocumentPartRef, ReferencedState, UsedDocument } from '../types';

export interface ResolveDocumentRefsInput {
  scope: TenantScope;
  mentions: string[];
  documentParts: DocumentPartRef[];
  admin: SupabaseClient;
  signal: AbortSignal;
}

export interface ResolvedDocumentRefs extends ReferencedState {
  ignored: number;
}

const REFERENCE_CHUNK_LIMIT = 30;
const PREVIEW_LENGTH = 200;

interface Scopable {
  eq(column: string, value: string): Scopable;
  is(column: string, value: null): Scopable;
}

/** Every documents query goes through here so the tenant predicate cannot be left off. */
function scoped<T>(query: T, predicate: TenantPredicate): T {
  const filter = query as unknown as Scopable;
  if (predicate.kind === 'org') return filter.eq('organization_id', predicate.organizationId) as unknown as T;
  if (predicate.kind === 'personal') return filter.eq('user_id', predicate.userId).is('organization_id', null) as unknown as T;
  return query;
}

interface DocumentRef {
  id: string;
  name: string;
}

function section(name: string, body: string): string {
  return `\n\n=== DOCUMENT: "${name}" ===\n${body}\n=== END OF DOCUMENT ===\n`;
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
  let context = '';
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

    const { data: chunks, error } = await admin
      .from('document_chunks')
      .select('content')
      .eq('document_id', docRef.id)
      .limit(REFERENCE_CHUNK_LIMIT)
      .abortSignal(signal);

    if (error) {
      console.error(`Error fetching chunks for document ${docRef.id}:`, error);
      continue;
    }

    if (chunks && chunks.length > 0) {
      context += section(docRef.name, chunks.map((chunk) => chunk.content).join('\n\n'));
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
      if (fullText) context += section(docRef.name, fullText);
      continue;
    }

    const { data: allChunks, error: allChunksError } = await admin
      .from('document_chunks')
      .select('*')
      .eq('document_id', docRef.id)
      .limit(REFERENCE_CHUNK_LIMIT)
      .abortSignal(signal);

    if (!allChunksError && allChunks && allChunks.length > 0) {
      context += section(docRef.name, allChunks.map((chunk) => chunk.content).join('\n\n'));
    } else {
      context += `\n\nDocument "${docRef.name}" was referenced but no content could be retrieved.\n`;
    }
  }

  if (ignored > 0) {
    console.warn('[RAG Tenant] Ignored document references outside the caller scope', { ignoredReferences: ignored });
  }

  return { usedDocuments, context, ignored };
}
