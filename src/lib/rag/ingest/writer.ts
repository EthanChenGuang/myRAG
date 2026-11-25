import { createHash } from 'node:crypto';
import type { RpcClient } from '../backend/supabase-rpc';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { HASH_NORMALIZATION_VERSION } from './hash';
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
  'invalid_parents',
  'invalid_profile',
  'chunking_profile_unsupported',
  'embedding_profile_unsupported',
  'embedding_profile_mismatch',
  'run_not_found',
  'run_profile_mismatch',
  'invalid_gap',
  'embedding_count_mismatch',
  'document_not_writable',
  'document_not_publishable',
  'document_is_current',
  'not_holdable',
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
  /** The admin type change only: begin a new version although the file is unchanged. Never set by a user upload. */
  forceNewVersion?: boolean;
}

export type BeginResult =
  | { outcome: 'created' | 'resumed'; documentId: string; version: number; lineageId: string }
  | { outcome: 'skipped_duplicate'; duplicateOf: string };

export interface DocumentFields {
  content_hash?: string | null;
  language?: string | null;
  /** D-13: every language with at least 10% of the detected tokens, in registry order. */
  languages?: string[];
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
  invoice_number?: string | null;
  supplier_name?: string | null;
  supplier_tax_id?: string | null;
  issue_date?: string | null;
  gross_total?: string | null;
  currency?: string | null;
  /** The parsed text, kept for the relevance filter and the source preview that read documents.content. */
  content?: string;
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
  /** The chunk's own language (D-13, RAG_LANGUAGE_AWARE_INGEST=on); without the key the chunk mirrors the document language. */
  language?: string;
  /** 0..1, rounded to 4 decimals; without the key the column stays null. */
  language_confidence?: number;
  metadata: Record<string, unknown>;
}

/** The vectors of one profile, lined up with the chunks; a non-legacy profile also names the host that served them. */
export type ProfileVectors = number[][] | { vectors: number[][]; host: string | null };

export interface WriteChunksOptions {
  /** Vectors keyed by embedding profile id. */
  embeddings: Record<string, ProfileVectors> | null;
  final: boolean;
  total: number;
}

export interface WriteChunksResult {
  chunksWritten: number;
  chunksDeleted: number;
}

/** A child of a chunking profile as rag_write_profile_chunks takes it: a chunk plus the index of the parent it belongs to. */
export interface ProfileChildWrite extends ChunkWrite {
  parent_index: number | null;
}

export interface ProfileParentWrite {
  parent_index: number;
  section_path: string[];
  content: string;
  token_count: number;
}

export interface WriteProfileChunksArgs {
  profileId: string;
  parents: ProfileParentWrite[];
  children: ProfileChildWrite[];
  /** Vectors keyed by embedding profile id, lined up with the children. */
  embeddings: Record<string, ProfileVectors> | null;
}

export interface WriteProfileChunksResult {
  parentsWritten: number;
  childrenWritten: number;
  parentsDeleted: number;
  childrenDeleted: number;
}

/** A row of the chunking profile registry. */
export interface ChunkingProfileRow {
  id: string;
  docType: string;
  childTokens: number;
  parentMode: 'none' | 'structure' | 'fixed';
  parentTokens: number | null;
  status: 'building' | 'ready' | 'active' | 'retired';
}

/** pending_review and held come from the publish guard of 0803: the version stays out of retrieval and nothing is swapped. */
export type PublishOutcome = 'published' | 'already_current' | 'quarantined' | 'pending_review' | 'held';

const PUBLISH_OUTCOMES: ReadonlySet<string> = new Set<PublishOutcome>(['published', 'already_current', 'quarantined', 'pending_review', 'held']);

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

export interface IngestOriginRow {
  lineageId: string | null;
  /** The object key of the stored original (documents.original_path), without the bucket name. */
  originalPath: string | null;
  source: string | null;
  sourceKey: string | null;
}

/** The newest run of a profile that applies to the caller's tenant. */
export interface BackfillRunRow {
  profileId: string;
  runId: string;
  status: string;
}

export interface BackfillGapArgs {
  runId: string;
  chunkIds: string[];
  profileId: string;
  reason: string;
}

/** The id rag_write_profile_chunks gives a parent or child: the first 16 bytes of sha256(document id : profile id : kind : index) as a UUID. */
export function profileRowIdFor(documentId: string, profileId: string, kind: 'parent' | 'child', index: number): string {
  const hex = createHash('sha256').update(`${documentId}:${profileId}:${kind}:${index}`, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The id rag_write_chunks gives a chunk: the first 16 bytes of sha256(document id : chunk index) as a UUID. */
export function chunkIdFor(documentId: string, chunkIndex: number): string {
  const hex = createHash('sha256').update(`${documentId}:${chunkIndex}`, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface IngestWriter {
  begin(args: BeginArgs): Promise<BeginResult>;
  findContentDuplicate(contentHash: string, documentId: string | null): Promise<string | null>;
  setFields(documentId: string, fields: DocumentFields): Promise<void>;
  saveState(documentId: string, processingStatus: string, state: Record<string, unknown>): Promise<void>;
  getDocument(documentId: string): Promise<IngestDocumentRow | null>;
  /** Where the version came from and where its original is stored; null for another tenant's or an unknown id. */
  getOrigin(documentId: string): Promise<IngestOriginRow | null>;
  writeChunks(documentId: string, chunks: ChunkWrite[], options: WriteChunksOptions): Promise<WriteChunksResult>;
  /** Parents and children of one chunking profile for this version, in one transaction; the document must belong to the scope's tenant. */
  writeProfileChunks(documentId: string, args: WriteProfileChunksArgs): Promise<WriteProfileChunksResult>;
  /** The chunking profile registry (every doc type, every status). */
  listChunkingProfiles(): Promise<ChunkingProfileRow[]>;
  publish(documentId: string): Promise<PublishResult>;
  /** Moves a processing version and its chunks to pending_review (rag_hold_document_for_review); refused with not_holdable otherwise. */
  holdForReview(documentId: string): Promise<{ documentId: string; version: number }>;
  /** rag_is_tenant_admin for this tenant: the Quarantine panel's access rule. */
  isTenantAdmin(userId: string): Promise<boolean>;
  /** The tenant's upload-approval exemptions (rag_upload_exemptions_for). */
  uploadExemptions(): Promise<Array<{ kind: string; ref: string }>>;
  /** Per profile the newest backfill run that applies to this tenant, a running one first. */
  findBackfillRuns(): Promise<BackfillRunRow[]>;
  /** Records chunks that have no vector for a profile; returns how many rows were written. */
  recordBackfillGap(args: BackfillGapArgs): Promise<number>;
  markFailed(documentId: string, reason: string): Promise<void>;
  /** The scope tenant's language shares over its current ready documents (rag_tenant_language_shares), largest first. */
  tenantLanguageShares?(): Promise<Array<{ language: string; share: number }>>;
  /** RAG_CAPTION_LANGUAGE=document: the language detected on each written picture caption, by image URL, onto this version's image chunks. */
  setImageChunkLanguages?(documentId: string, items: Array<{ imageUrl: string; language: string }>): Promise<number>;
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

async function callRpc(db: RpcClient, signal: AbortSignal, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new IngestWriterError(rpc, response.error.code ?? null, reasonOf(response.error.message));
  return (response.data ?? []) as Row[];
}

const TENANT_KEY_RE = /^(?:s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** True for the three tenant key shapes: `s:default`, `u:<uuid>` and `o:<uuid>`, in lower case. */
export function isTenantKey(value: string): boolean {
  return TENANT_KEY_RE.test(value);
}

export interface ContentHashBackfillWriter {
  /**
   * Stores the normalised content hash and its version on one legacy document. The tenant key is the one the
   * document row itself carries; rag_set_document_fields refuses the call when the document is not in that tenant.
   */
  setContentHash(documentId: string, tenantKey: string, contentHash: string): Promise<void>;
}

/**
 * The operator backfill has no request scope: it walks the rows of every tenant (or one named tenant) and
 * writes each row under the tenant key stored on that row. It can set the hash fields and nothing else.
 */
export function createContentHashBackfillWriter(input: { db: RpcClient; signal: AbortSignal }): ContentHashBackfillWriter {
  const { db, signal } = input;
  return {
    async setContentHash(documentId, tenantKey, contentHash) {
      if (!isTenantKey(tenantKey)) throw new IngestWriterError('rag_set_document_fields', 'invalid_tenant_key');
      const rows = await callRpc(db, signal, 'rag_set_document_fields', {
        p_document_id: documentId,
        p_tenant_key: tenantKey,
        p_fields: { content_hash: contentHash, metadata: { content_hash_version: HASH_NORMALIZATION_VERSION } },
      });
      if (!rows[0]) throw new IngestWriterError('rag_set_document_fields', 'no_row');
    },
  };
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

  const call = (rpc: string, args: Record<string, unknown>): Promise<Row[]> => callRpc(db, signal, rpc, args);

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
        ...(args.forceNewVersion ? { p_force_new_version: true } : {}),
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

    async getOrigin(documentId) {
      const rows = await call('rag_get_ingest_origin', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
      });
      const row = rows[0];
      if (!row) return null;
      return {
        lineageId: text(row, 'lineage_id'),
        originalPath: text(row, 'original_path'),
        source: text(row, 'source'),
        sourceKey: text(row, 'source_key'),
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

    async writeProfileChunks(documentId, args) {
      const row = await callOne('rag_write_profile_chunks', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_profile_id: args.profileId,
        p_parents: args.parents,
        p_children: args.children,
        p_embeddings: args.embeddings,
        p_final: true,
        p_total: args.children.length,
      });
      return {
        parentsWritten: integer(row, 'parents_written') ?? 0,
        childrenWritten: integer(row, 'children_written') ?? 0,
        parentsDeleted: integer(row, 'parents_deleted') ?? 0,
        childrenDeleted: integer(row, 'children_deleted') ?? 0,
      };
    },

    async listChunkingProfiles() {
      identity();
      const rows = await call('rag_list_chunking_profiles', {});
      const profiles: ChunkingProfileRow[] = [];
      for (const row of rows) {
        const id = text(row, 'id');
        const typeKey = text(row, 'doc_type');
        const parentMode = text(row, 'parent_mode');
        const status = text(row, 'status');
        const childTokens = integer(row, 'child_tokens');
        if (id === null || typeKey === null || childTokens === null) continue;
        if (parentMode !== 'none' && parentMode !== 'structure' && parentMode !== 'fixed') continue;
        if (status !== 'building' && status !== 'ready' && status !== 'active' && status !== 'retired') continue;
        profiles.push({ id, docType: typeKey, childTokens, parentMode, parentTokens: integer(row, 'parent_tokens'), status });
      }
      return profiles;
    },

    async publish(documentId) {
      const row = await callOne('rag_publish_document_version', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
      });
      const outcome = text(row, 'outcome');
      if (outcome === null || !PUBLISH_OUTCOMES.has(outcome)) {
        throw new IngestWriterError('rag_publish_document_version', 'bad_response');
      }
      return {
        outcome: outcome as PublishOutcome,
        documentId: requireText('rag_publish_document_version', row, 'document_id'),
        version: integer(row, 'version') ?? 0,
        supersededDocumentId: text(row, 'superseded_document_id'),
      };
    },

    async holdForReview(documentId) {
      const row = await callOne('rag_hold_document_for_review', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
      });
      if (text(row, 'outcome') !== 'pending_review') throw new IngestWriterError('rag_hold_document_for_review', 'bad_response');
      return { documentId: requireText('rag_hold_document_for_review', row, 'document_id'), version: integer(row, 'version') ?? 0 };
    },

    async isTenantAdmin(userId) {
      signal.throwIfAborted();
      const response = await db.rpc('rag_is_tenant_admin', { p_user: userId, p_tenant_key: identity().tenantKey }).abortSignal(signal);
      signal.throwIfAborted();
      if (response.error) throw new IngestWriterError('rag_is_tenant_admin', response.error.code ?? null, reasonOf(response.error.message));
      const data: unknown = response.data;
      if (typeof data === 'boolean') return data;
      if (Array.isArray(data) && data.length === 1) {
        const first: unknown = data[0];
        if (typeof first === 'boolean') return first;
        if (first && typeof first === 'object') {
          const value = (first as Row).rag_is_tenant_admin;
          if (typeof value === 'boolean') return value;
        }
      }
      throw new IngestWriterError('rag_is_tenant_admin', 'bad_response');
    },

    async uploadExemptions() {
      const rows = await call('rag_upload_exemptions_for', { p_tenant_key: identity().tenantKey });
      const exemptions: Array<{ kind: string; ref: string }> = [];
      for (const row of rows) {
        const kind = text(row, 'kind');
        const ref = text(row, 'ref');
        if (kind !== null && ref !== null) exemptions.push({ kind, ref });
      }
      return exemptions;
    },

    async findBackfillRuns() {
      const rows = await call('rag_latest_backfill_runs', { p_tenant_key: identity().tenantKey });
      const runs: BackfillRunRow[] = [];
      for (const row of rows) {
        const profileId = text(row, 'profile_id');
        const runId = text(row, 'run_id');
        const status = text(row, 'status');
        if (profileId !== null && runId !== null && status !== null) runs.push({ profileId, runId, status });
      }
      return runs;
    },

    async recordBackfillGap(args) {
      if (args.chunkIds.length === 0) return 0;
      const row = await callOne('rag_record_backfill_gap', {
        p_run_id: args.runId,
        p_chunk_ids: args.chunkIds,
        p_profile_id: args.profileId,
        p_reason: args.reason,
        p_tenant_key: identity().tenantKey,
      });
      return integer(row, 'gaps_recorded') ?? 0;
    },

    async markFailed(documentId, reason) {
      await callOne('rag_mark_document_failed', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_reason: reason,
      });
    },

    async tenantLanguageShares() {
      const rows = await call('rag_tenant_language_shares', { p_tenant_key: identity().tenantKey });
      const shares: Array<{ language: string; share: number }> = [];
      for (const row of rows) {
        const language = text(row, 'language');
        const share = typeof row.share === 'number' ? row.share : Number(row.share);
        if (language !== null && Number.isFinite(share)) shares.push({ language, share });
      }
      return shares;
    },

    async setImageChunkLanguages(documentId, items) {
      if (items.length === 0) return 0;
      const row = await callOne('rag_set_image_chunk_languages', {
        p_document_id: documentId,
        p_tenant_key: identity().tenantKey,
        p_items: items.map((item) => ({ image_url: item.imageUrl, language: item.language })),
      });
      return integer(row, 'chunks_updated') ?? 0;
    },
  };
}

/** A refused or failed re-embed RPC. Carries the function name, the code and the refusal words only, never the rest of a database message. */
export class ReembedWriterError extends Error {
  readonly rpc: string;
  readonly code: string | null;
  /** The first word of the message, for example reembed_refused, rollback_refused, embedding_profile_mismatch or tenant_mismatch. */
  readonly reason: string | null;
  /** The word after the colon of a refusal, for example profile_is_active. */
  readonly detail: string | null;

  constructor(rpc: string, code: string | null, reason: string | null = null, detail: string | null = null) {
    super(`[Re-embed] ${rpc} failed${code ? ` (${code})` : ''}${reason ? `: ${reason}${detail ? ` ${detail}` : ''}` : ''}`);
    this.name = 'ReembedWriterError';
    this.rpc = rpc;
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

const REEMBED_REASONS = new Set(['reembed_refused', 'rollback_refused', 'embedding_profile_mismatch', 'tenant_mismatch', 'invalid_rows']);

export interface ReembedRun {
  runId: string;
  profileId: string;
  tenantKey: string | null;
  cursorChunkId: string | null;
  chunksTotal: number;
  chunksDone: number;
  tokens: number;
  status: string;
  derivedFrom: string | null;
  provider: string;
  model: string;
  dims: number;
  storage: string;
  profileStatus: string;
}

/** A stored chunk as the re-embed job reads it: the columns the embedding text is rebuilt from and nothing else. */
export interface ReembedChunk {
  id: string;
  documentId: string;
  tenantKey: string;
  content: string;
  sectionPath: string[];
  chunkKind: string;
  docType: string | null;
  templateRow: Record<string, string | null>;
  hasGap: boolean;
}

export interface ReembedVector {
  chunkId: string;
  vector: number[];
  host: string | null;
}

export interface ReembedCountRow {
  tenantKey: string;
  chunks: number;
  chunksMissing: number;
  contentChars: number;
}

export interface ReembedLegacyGuard {
  versionedDocuments: number;
  profilesInUse: string[];
}

export interface ReembedWriter {
  start(args: { profileId: string; tenantKey: string | null; actor: string; derivedFrom: string | null }): Promise<ReembedRun>;
  get(runId: string): Promise<ReembedRun | null>;
  resume(runId: string, actor: string): Promise<ReembedRun>;
  nextBatch(runId: string, after: string | null, limit: number): Promise<ReembedChunk[]>;
  missingBatch(runId: string, after: string | null, limit: number): Promise<ReembedChunk[]>;
  /** Upserts the vectors and moves the cursor and counts in one transaction; a null cursor leaves the cursor alone. */
  writeBatch(runId: string, rows: ReembedVector[], cursor: string | null, tokens: number): Promise<{ written: number; done: number; cursor: string | null }>;
  deriveBatch(runId: string, limit: number): Promise<{ derived: number; done: number; cursor: string | null }>;
  remaining(runId: string): Promise<number>;
  finish(runId: string, status: 'completed' | 'failed'): Promise<{ status: string; missing: number }>;
  rollback(runId: string, actor: string): Promise<{ rowsDeleted: number; profileStatus: string }>;
  count(profileId: string, tenantKey: string | null): Promise<ReembedCountRow[]>;
  previewBatch(profileId: string, tenantKey: string | null, after: string | null, limit: number): Promise<ReembedChunk[]>;
  legacyGuard(): Promise<ReembedLegacyGuard>;
  /** The profile's doc types (0440), or null for an unscoped profile or an unknown id. */
  profileScope(profileId: string): Promise<string[] | null>;
}

function reembedRefusal(message: string | undefined): { reason: string | null; detail: string | null } {
  const match = /^([a-z_]+)(?:: ([a-z_]+))?/.exec(message ?? '');
  const reason = match?.[1];
  if (reason === undefined || !REEMBED_REASONS.has(reason)) return { reason: null, detail: null };
  return { reason, detail: match?.[2] ?? null };
}

function count(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function parseRun(rpc: string, row: Row): ReembedRun {
  return {
    runId: requireText(rpc, row, 'run_id'),
    profileId: requireText(rpc, row, 'profile_id'),
    tenantKey: text(row, 'tenant_key'),
    cursorChunkId: text(row, 'cursor_chunk_id'),
    chunksTotal: count(row, 'chunks_total'),
    chunksDone: count(row, 'chunks_done'),
    tokens: count(row, 'tokens'),
    status: text(row, 'status') ?? 'running',
    derivedFrom: text(row, 'derived_from'),
    provider: text(row, 'provider') ?? '',
    model: text(row, 'model') ?? '',
    dims: count(row, 'dims'),
    storage: text(row, 'storage') ?? '',
    profileStatus: text(row, 'profile_status') ?? '',
  };
}

function parseChunk(rpc: string, row: Row): ReembedChunk {
  const sectionPath = Array.isArray(row.section_path) ? row.section_path.filter((entry): entry is string => typeof entry === 'string') : [];
  const templateRow: Record<string, string | null> = {};
  if (typeof row.template_row === 'object' && row.template_row !== null && !Array.isArray(row.template_row)) {
    for (const [key, value] of Object.entries(row.template_row as Row)) templateRow[key] = typeof value === 'string' ? value : null;
  }
  return {
    id: requireText(rpc, row, 'id'),
    documentId: requireText(rpc, row, 'document_id'),
    tenantKey: requireText(rpc, row, 'tenant_key'),
    content: text(row, 'content') ?? '',
    sectionPath,
    chunkKind: text(row, 'chunk_kind') ?? 'text',
    docType: text(row, 'doc_type'),
    templateRow,
    hasGap: row.has_gap === true,
  };
}

/**
 * The operator re-embed job's only door to the database. Every call after the start names a run, and the SQL takes the profile and the tenant
 * scope from the run row, so a job limited to one tenant cannot be pointed at another tenant's chunks from here. Vectors get the tenant key of
 * the chunk they belong to inside the database (rag_chunk_embeddings_guard); nothing here mints a tenant scope.
 */
export function createReembedWriter(input: { db: RpcClient; signal: AbortSignal }): ReembedWriter {
  const { db, signal } = input;

  async function call(rpc: string, args: Record<string, unknown>): Promise<Row[]> {
    signal.throwIfAborted();
    const response = await db.rpc(rpc, args).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      const { reason, detail } = reembedRefusal(response.error.message);
      throw new ReembedWriterError(rpc, response.error.code ?? null, reason, detail);
    }
    return (response.data ?? []) as Row[];
  }

  async function callOne(rpc: string, args: Record<string, unknown>): Promise<Row> {
    const row = (await call(rpc, args))[0];
    if (!row) throw new ReembedWriterError(rpc, 'no_row');
    return row;
  }

  const writer: ReembedWriter = {
    async start(args) {
      const row = await callOne('rag_reembed_start_run', {
        p_profile_id: args.profileId,
        p_tenant_key: args.tenantKey,
        p_actor: args.actor,
        p_derived_from: args.derivedFrom,
      });
      const runId = requireText('rag_reembed_start_run', row, 'run_id');
      const run = await writer.get(runId);
      if (!run) throw new ReembedWriterError('rag_reembed_start_run', 'no_row');
      return run;
    },

    async get(runId) {
      const rows = await call('rag_reembed_get_run', { p_run_id: runId });
      return rows[0] ? parseRun('rag_reembed_get_run', rows[0]) : null;
    },

    async resume(runId, actor) {
      return parseRun('rag_reembed_resume_run', await callOne('rag_reembed_resume_run', { p_run_id: runId, p_actor: actor }));
    },

    async nextBatch(runId, after, limit) {
      const rows = await call('rag_reembed_next_batch', { p_run_id: runId, p_after: after, p_limit: limit });
      return rows.map((row) => parseChunk('rag_reembed_next_batch', row));
    },

    async missingBatch(runId, after, limit) {
      const rows = await call('rag_reembed_missing_batch', { p_run_id: runId, p_after: after, p_limit: limit });
      return rows.map((row) => parseChunk('rag_reembed_missing_batch', row));
    },

    async writeBatch(runId, rows, cursor, tokens) {
      const row = await callOne('rag_reembed_write_batch', {
        p_run_id: runId,
        p_rows: rows.map((entry) => ({ chunk_id: entry.chunkId, vector: entry.vector, host: entry.host })),
        p_cursor: cursor,
        p_tokens: Math.max(0, Math.trunc(tokens)),
      });
      return { written: count(row, 'chunks_written'), done: count(row, 'chunks_done'), cursor: text(row, 'cursor_chunk_id') };
    },

    async deriveBatch(runId, limit) {
      const row = await callOne('rag_reembed_derive_batch', { p_run_id: runId, p_limit: limit });
      return { derived: count(row, 'chunks_derived'), done: count(row, 'chunks_done'), cursor: text(row, 'cursor_chunk_id') };
    },

    async remaining(runId) {
      return count(await callOne('rag_reembed_remaining', { p_run_id: runId }), 'chunks_missing');
    },

    async finish(runId, status) {
      const row = await callOne('rag_reembed_finish_run', { p_run_id: runId, p_status: status });
      return { status: text(row, 'status') ?? status, missing: count(row, 'chunks_missing') };
    },

    async rollback(runId, actor) {
      const row = await callOne('rag_reembed_rollback_run', { p_run_id: runId, p_actor: actor });
      return { rowsDeleted: count(row, 'rows_deleted'), profileStatus: text(row, 'profile_status') ?? '' };
    },

    async count(profileId, tenantKey) {
      const rows = await call('rag_reembed_count', { p_profile_id: profileId, p_tenant_key: tenantKey });
      return rows.map((row) => ({
        tenantKey: requireText('rag_reembed_count', row, 'tenant_key'),
        chunks: count(row, 'chunks'),
        chunksMissing: count(row, 'chunks_missing'),
        contentChars: count(row, 'content_chars'),
      }));
    },

    async previewBatch(profileId, tenantKey, after, limit) {
      const rows = await call('rag_reembed_preview_batch', { p_profile_id: profileId, p_tenant_key: tenantKey, p_after: after, p_limit: limit });
      return rows.map((row) => parseChunk('rag_reembed_preview_batch', row));
    },

    async legacyGuard() {
      const row = await callOne('rag_reembed_legacy_guard', {});
      return {
        versionedDocuments: count(row, 'versioned_documents'),
        profilesInUse: Array.isArray(row.profiles_in_use) ? row.profiles_in_use.filter((id): id is string => typeof id === 'string') : [],
      };
    },

    async profileScope(profileId) {
      const row = (await call('rag_list_embedding_profile_scopes', {})).find((entry) => entry.id === profileId);
      if (!row || !Array.isArray(row.doc_types)) return null;
      const scope = row.doc_types.filter((entry): entry is string => typeof entry === 'string');
      return scope.length > 0 ? scope : null;
    },
  };
  return writer;
}
