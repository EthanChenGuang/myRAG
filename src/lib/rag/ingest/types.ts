import type { DocTypeDetection, ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../tenant/scope';
import type { TraceCollector } from '../trace/collector';
import type { IngestConfig } from './config';
import type { IngestDeps } from './deps';
import type { DocType, ProcessingProfile } from './profiles/load';
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
}

export type IngestInput = IngestInputBase &
  ({ text: string; file?: undefined } | { file: Uint8Array; text?: undefined });

export const DEFAULT_INGEST_DEADLINE_MS = 50000;

export type IngestStatus = 'ready' | 'skipped_duplicate' | 'quarantined' | 'processing' | 'failed';

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
