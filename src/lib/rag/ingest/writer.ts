import type { RpcClient } from '../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import type { ChunkKind, DocTypeOrigin, IngestSource } from './types';

type Row = Record<string, unknown>;

/** Reason words the SQL functions raise; only these ever leave the writer, never the rest of a message. */
const KNOWN_REASONS = new Set([
  'tenant_mismatch',
  'invalid_argument',
  'invalid_source',
  'invalid_fields',
  'invalid_field',
  'invalid_status',
  'invalid_metadata',
  'invalid_state',
  'invalid_chunks',
  'invalid_chunk',
  'invalid_total',
  'invalid_embeddings',
  'embedding_profile_unsupported',
  'embedding_count_mismatch',
  'document_not_writable',
  'document_not_publishable',
  'document_is_current',
]);

/** A failed writer RPC. Carries the function name and the error code only: the database message can echo row content. */
export class IngestWriterError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  readonly reason: string | null;

  constructor(rpc: string, code: string | null, reason: string | null = null) {
    super(`[Ingest Writer] ${rpc} failed${code ? ` (${code})` : ''}`);
    this.name = 'IngestWriterError';
    this.rpc = rpc;
    this.code = code;
    this.reason = reason;
  }
}

export interface BeginArgs {
  source: IngestSource;
  sourceKey: string;
  filename: string;
  fileSha256: string | null;
  docType: string;
  docTypeOrigin: DocTypeOrigin;
  profileId: string;
  profileVersion: number;
}

export type BeginResult =
  | { outcome: 'created' | 'resumed'; documentId: string; version: number; lineageId: string }
  | { outcome: 'skipped_duplicate'; duplicateOf: string };

export interface DocumentFields {
  content_hash?: string | null;
  language?: string | null;
  doc_date?: string | null;
  doc_type?: string | null;
  doc_type_origin?: string | null;
  parser_used?: string | null;
  parser_version?: string | null;
  processing_profile_id?: string | null;
  processing_profile_version?: number | null;
  original_path?: string | null;
  source_provider?: string | null;
  source_file_id?: string | null;
  source_connection_id?: string | null;
  status?: 'processing' | 'quarantined' | 'failed' | 'deleted';
  metadata?: Record<string, unknown>;
}

export interface ChunkWrite {
  content: string;
  chunk_index: number;
  section_path: string[];
  chunk_kind: ChunkKind;
  embedding_text_version: number;
  page_start?: number | null;
  page_end?: number | null;
  content_hash?: string | null;
  lexical_text?: string | null;
  metadata: Record<string, unknown>;
}

export interface WriteChunksOptions {
  /** Vectors keyed by embedding profile id; each array lines up with the chunks. */
  embeddings: Record<string, number[][]> | null;
  final: boolean;
  total: number;
}

export interface WriteChunksResult {
  chunksWritten: number;
  chunksDeleted: number;
}

export type PublishOutcome = 'published' | 'already_current' | 'quarantined';

export interface PublishResult {
  outcome: PublishOutcome;
  documentId: string;
  version: number;
  supersededDocumentId: string | null;
}

export interface IngestDocumentRow {
  status: string;
  version: number;
  processingStatus: string | null;
  processingState: Record<string, unknown>;
  filename: string;
  docType: string;
  parserUsed: string | null;
  createdAt: string;
}

export interface IngestWriter {
  begin(args: BeginArgs): Promise<BeginResult>;
  findContentDuplicate(contentHash: string, documentId: string | null): Promise<string | null>;
  setFields(documentId: string, fields: DocumentFields): Promise<void>;
  saveState(documentId: string, processingStatus: string, state: Record<string, unknown>): Promise<void>;
  getDocument(documentId: string): Promise<IngestDocumentRow | null>;
  writeChunks(documentId: string, chunks: ChunkWrite[], options: WriteChunksOptions): Promise<WriteChunksResult>;
  publish(documentId: string): Promise<PublishResult>;
  markFailed(documentId: string, reason: string): Promise<void>;
}

export interface CreateIngestWriterInput {
  db: RpcClient;
  scope: TenantScope;
  signal: AbortSignal;
}

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function requireText(rpc: string, row: Row, key: string): string {
  const value = text(row, key);
  if (value === null) throw new IngestWriterError(rpc, 'bad_response');
  return value;
}

function integer(row: Row, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function reasonOf(message: string | undefined): string | null {
  const word = /^[a-z_]+/.exec(message ?? '')?.[0];
  return word !== undefined && KNOWN_REASONS.has(word) ? word : null;
}

/**
 * The only caller of the rag_* writer RPCs. The tenant key, user id and organization id come from the
 * scope on every call and from nowhere else; a single-tenant scope never sends a user id.
 */
export function createIngestWriter(input: CreateIngestWriterInput): IngestWriter {
  const { db, scope, signal } = input;

  function identity(): { tenantKey: string; userId: string | null; orgId: string | null } {
    assertTenantScope(scope);
    if (scope.kind === 'single') return { tenantKey: scopeKey(scope).toLowerCase(), userId: null, orgId: null };
    return {
      tenantKey: scopeKey(scope).toLowerCase(),
      userId: scope.userId?.toLowerCase() ?? null,
      orgId: scope.kind === 'org' ? (scope.organizationId?.toLowerCase() ?? null) : null,
    };
  }

  async function call(rpc: string, args: Record<string, unknown>): Promise<Row[]> {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) throw new IngestWriterError(rpc, response.error.code ?? null, reasonOf(response.error.message));
    return (response.data ?? []) as Row[];
  }

  async function callOne(rpc: string, args: Record<string, unknown>): Promise<Row> {
    const rows = await call(rpc, args);
    const row = rows[0];
    if (!row) throw new IngestWriterError(rpc, 'no_row');
    return row;
  }

  return {
    async begin(args) {
      const { tenantKey, userId, orgId } = identity();
      const row = await callOne('rag_begin_document_version', {
        p_tenant_key: tenantKey,
        p_user_id: userId,
        p_org_id: orgId,
        p_source: args.source,
        p_source_key: args.sourceKey,
        p_filename: args.filename,
        p_file_sha256: args.fileSha256,
        p_doc_type: args.docType,
        p_doc_type_origin: args.docTypeOrigin,
        p_profile_id: args.profileId,
        p_profile_version: args.profileVersion,
      });
      const outcome = text(row, 'outcome');
      if (outcome === 'skipped_duplicate') {
        return { outcome, duplicateOf: requireText('rag_begin_document_version', row, 'duplicate_of') };
      }
      if (outcome !== 'created' && outcome !== 'resumed') throw new IngestWriterError('rag_begin_document_version', 'bad_response');
      const version = integer(row, 'version');
      if (version === null) throw new IngestWriterError('rag_begin_document_version', 'bad_response');
      return {
        outcome,
        documentId: requireText('rag_begin_document_version', row, 'document_id'),
        version,
        lineageId: requireText('rag_begin_document_version', row, 'lineage_id'),
      };
    },

    async findContentDuplicate(contentHash, documentId) {
      const rows = await call('rag_find_content_duplicate', {
        p_tenant_key: identity().tenantKey,
        p_content_hash: contentHash,
        p_document_id: documentId,
      });
      const first = rows[0];
      return first ? text(first, 'duplicate_of') : null;
    },

    async setFields(documentId, fields) {
      await callOne('rag_set_document_fields', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_fields: fields,
      });
    },

    async saveState(documentId, processingStatus, state) {
      await callOne('rag_save_ingest_state', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_processing_status: processingStatus,
        p_state: state,
      });
    },

    async getDocument(documentId) {
      const rows = await call('rag_get_ingest_document', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
      });
      const row = rows[0];
      if (!row) return null;
      const state = row.processing_state;
      return {
        status: requireText('rag_get_ingest_document', row, 'status'),
        version: integer(row, 'version') ?? 0,
        processingStatus: text(row, 'processing_status'),
        processingState: typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {},
        filename: text(row, 'filename') ?? '',
        docType: text(row, 'doc_type') ?? '',
        parserUsed: text(row, 'parser_used'),
        createdAt: text(row, 'created_at') ?? '',
      };
    },

    async writeChunks(documentId, chunks, options) {
      const row = await callOne('rag_write_chunks', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_chunks: chunks,
        p_embeddings: options.embeddings,
        p_final: options.final,
        p_total: options.total,
      });
      return { chunksWritten: integer(row, 'chunks_written') ?? 0, chunksDeleted: integer(row, 'chunks_deleted') ?? 0 };
    },

    async publish(documentId) {
      const row = await callOne('rag_publish_document_version', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
      });
      const outcome = text(row, 'outcome');
      if (outcome !== 'published' && outcome !== 'already_current' && outcome !== 'quarantined') {
        throw new IngestWriterError('rag_publish_document_version', 'bad_response');
      }
      return {
        outcome,
        documentId: requireText('rag_publish_document_version', row, 'document_id'),
        version: integer(row, 'version') ?? 0,
        supersededDocumentId: text(row, 'superseded_document_id'),
      };
    },

    async markFailed(documentId, reason) {
      await callOne('rag_mark_document_failed', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_reason: reason,
      });
    },
  };
}
