import type { DocTypeDetection, ParseResult, UploadApproval } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { IngestConfig } from './config';
import type { IngestDeps } from './deps';
import type { DocType, ProcessingProfile } from './profiles/load';
import type { StateStore } from './state-store';
import type { IngestWriter } from './writer';

export type { DocType, ProcessingProfile };

export const INGEST_SOURCES = ['chat_upload', 'config_upload', 'nango', 'scraper', 'image_upload', 'ai_to_rag'] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export type StageName =
  | 'identify'
  | 'file_hash_dedup'
  | 'store_original'
  | 'parse'
  | 'content_hash_dedup'
  | 'scan_injection'
  | 'chunk'
  | 'enrich'
  | 'extract'
  | 'images'
  | 'embed'
  | 'write'
  | 'publish';

export type DocTypeOrigin = 'picked' | 'source_default' | 'tenant_default' | 'auto' | 'fallback';

/** What the source says about the document it hands over; written to the document row right after the version begins. */
export interface IngestOrigin {
  sourceProvider?: string;
  sourceFileId?: string;
  sourceConnectionId?: string;
  metadata?: Record<string, string>;
}

export interface IngestOptions {
  origin?: IngestOrigin;
  /** Image uploads only: the public URL of the stored picture, written to the chunk metadata so the chat can show it. */
  imageUrl?: string;
  /** Image uploads only: the free text the uploader gave the picture, kept as plain metadata. */
  imageContext?: string;
  /** Nango sync only: the connection and folder the file came from, which the admin doc-type defaults can name. */
  nangoConnectionId?: string;
  nangoFolderId?: string;
  [key: string]: unknown;
}

/**
 * Set by changeDocumentType alone (the admin type change): the run starts a new version of a file whose bytes did not change, so the
 * file-hash and content-hash skips do not apply, and it may start from the stored parse output of an earlier version of the same lineage.
 * A user upload never sets it. It is kept in the saved state, so a resumed run knows it too.
 */
export interface TypeChangeState {
  /** The version whose parse.md (and chunks.json, docling.json) this run starts from; null: parse the stored original. */
  reuseParseOfVersion: number | null;
  /** parser_used and parser_version of that version, kept on the new row when its parse output is reused. */
  reusedParser: { parser: 'docling' | 'llamaparse' | 'text'; version: string } | null;
}

interface IngestInputBase {
  scope: TenantScope;
  source: IngestSource;
  sourceKey: string;
  filename: string;
  mimeType: string;
  /** The type picked for the file, or 'auto' to detect it. Absent: the admin defaults decide. */
  docType?: DocType | 'auto';
  options?: IngestOptions;
  signal: AbortSignal;
  trace?: TraceCollector;
  /** Request budget in milliseconds from the start of the call. Defaults to DEFAULT_INGEST_DEADLINE_MS. */
  deadlineMs?: number;
  /** Admin type change only; see TypeChangeState. */
  typeChange?: TypeChangeState;
  /**
   * The server-verified uploader (the session user, or the owner of a connector's connection), for the upload-approval decision
   * (D-37). Never taken from a request body. A personal or organization scope that carries its user takes precedence over it.
   */
  uploaderId?: string | null;
}

export type IngestInput = IngestInputBase &
  ({ text: string; file?: undefined } | { file: Uint8Array; text?: undefined });

export const DEFAULT_INGEST_DEADLINE_MS = 50000;

export type IngestStatus = 'ready' | 'skipped_duplicate' | 'quarantined' | 'pending_review' | 'processing' | 'failed';

export interface IngestResult {
  status: IngestStatus;
  documentId: string | null;
  version: number | null;
  parserUsed: string | null;
  chunkCount: number;
  warnings: string[];
  duplicateOf?: string;
  reason?: string;
}

export interface IngestState {
  lastCompleted: StageName | null;
  chunkCount: number | null;
  docTypeOrigin: DocTypeOrigin | null;
  parseJob: { parser: string; jobId: string; submittedAt: string; attempt: number } | null;
  artifacts: Record<string, string>;
  docTypeDetection: { signals: string[]; refined: DocType | null; reparsed: boolean; detection?: DocTypeDetection } | null;
  quarantine: { ruleIds: string[]; released: boolean } | null;
  invoice: { extractor: string; status: string } | null;
  /** Caption progress, and for a whole image what a resumed run needs without the upload: the public URL, the context and the media type. */
  images: {
    nextIndex: number;
    captioned: number;
    imageUrl?: string;
    imageContext?: string;
    mimeType?: string;
    /** Pictures inside a document: positions of the kept pictures that were given up (bytes gone, type unsupported, caption failed), so a resumed run does not try them again. */
    skipped?: number[];
    /** Pictures inside a document: how many kept pictures are stored in the public bucket, in order. */
    uploaded?: number;
  } | null;
  embeddingTargets: string[];
  embeddingGaps: Array<{ profileId: string; chunkIndex: number }>;
  /** Present on an admin type change only; absent on every other run. */
  typeChange?: TypeChangeState;
  /** The upload-approval decision of identify (D-36, D-56); absent while RAG_UPLOAD_APPROVAL is off. A queued job takes it from its snapshot. */
  approval?: UploadApproval;
  /** A job of a batch with hold_publish (D-12): publish records the hold on the document instead of making it current. */
  publishHold?: { batchId: string };
}

export function emptyIngestState(): IngestState {
  return {
    lastCompleted: null,
    chunkCount: null,
    docTypeOrigin: null,
    parseJob: null,
    artifacts: {},
    docTypeDetection: null,
    quarantine: null,
    invoice: null,
    images: null,
    embeddingTargets: [],
    embeddingGaps: [],
  };
}

export type ChunkKind = 'text' | 'table' | 'image' | 'invoice_header';

/** A chunk as the chunker produces it: plain content, never prefixed with its path or document name. */
export interface ChunkDraft {
  content: string;
  section_path: string[];
  chunk_kind: ChunkKind;
  page_start: number | null;
  page_end: number | null;
  metadata: Record<string, unknown>;
  /** Set by the enrich stage. */
  content_hash?: string;
  lexical_text?: string;
}

/** What a chunker returns: the drafts plus stable warning codes for the stage to report. */
export interface ChunkResult {
  chunks: ChunkDraft[];
  warnings: string[];
  /** The document is one image whose caption the images stage turns into its single chunk; no text chunk is expected. */
  captionOnly?: boolean;
}

export interface IngestIdentity {
  tenantKey: string;
  filename: string;
  fileSha256: string;
  docType: DocType;
  docTypeOrigin: DocTypeOrigin;
  profile: ProcessingProfile;
  bytes: Uint8Array | null;
}

export interface IngestDocumentRef {
  id: string;
  version: number;
  /** The identity's lineage: the middle part of every object key of this version. */
  lineageId: string;
  /** documents.original_path of a resumed run: the object key of the stored original. */
  originalPath?: string | null;
  resumed: boolean;
}

/** What rebuilding the stage inputs of a resumed run can answer: done, not possible (the run stays processing), or failed with a reason. */
export type RehydrateResult = boolean | { failed: string };

/** Working data of one run. Not persisted; plan 03-13b moves what a resume needs into the object store. */
export interface IngestWork {
  parseText: string | null;
  /** Docling's own chunks from the parse result; the chunk stage uses them when the profile allows. */
  parseChunks?: ParseResult['chunks'] | null;
  /** The pictures the parser found (a whole image is one picture), for the images stage. */
  pictures?: ParseResult['pictures'] | null;
  /** Set by the chunk stage when the chunker is image_caption: the images stage produces the only chunk. */
  captionOnly?: boolean;
  parserVersion: string | null;
  /** Promoted document columns of this run (the invoice fields); the profile's embedding header template renders from them. */
  templateRow?: Record<string, string | null> | null;
  chunks: ChunkDraft[];
  chunksWritten: number;
}

export interface StageContext {
  readonly input: IngestInput;
  readonly deps: IngestDeps;
  readonly writer: IngestWriter;
  readonly config: IngestConfig;
  readonly signal: AbortSignal;
  /** Absolute time in deps.now() units by which the request must have returned. */
  readonly deadline: number;
  readonly state: IngestState;
  /** Where the resumable state is kept. Unset: the document row, as every inline run does. A queued job uses the ledger (D-01). */
  readonly store?: StateStore;
  readonly warnings: string[];
  identity: IngestIdentity | null;
  document: IngestDocumentRef | null;
  parserUsed: string | null;
  work: IngestWork;
}

/** What a stage that continues tells the trace: it ran switched off, took a fallback, or reached a named outcome. */
export interface StageNote {
  disabled?: boolean;
  fallbackReason?: string;
  outcome?: string;
}

export type StageOutcome =
  | ({ kind: 'next' } & StageNote)
  | { kind: 'done'; result: IngestResult }
  | { kind: 'fail'; reason: string }
  | { kind: 'yield'; reason: string };

export interface StageSpec {
  name: StageName;
  minMsNeeded: number;
  run(ctx: StageContext): Promise<StageOutcome>;
}

/** A stage failure with a stable reason that the runner reports instead of `<stage>_failed`. */
export class IngestStageError extends Error {
  readonly stage: StageName;
  readonly reason: string;

  constructor(stage: StageName, reason: string) {
    super(`[Ingest] stage ${stage} failed (${reason})`);
    this.name = 'IngestStageError';
    this.stage = stage;
    this.reason = reason;
  }
}

export function requireIdentity(ctx: StageContext, stage: StageName): IngestIdentity {
  if (!ctx.identity) throw new IngestStageError(stage, 'identity_missing');
  return ctx.identity;
}

export function requireDocument(ctx: StageContext, stage: StageName): IngestDocumentRef {
  if (!ctx.document) throw new IngestStageError(stage, 'document_missing');
  return ctx.document;
}
