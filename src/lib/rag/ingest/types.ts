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

export interface IngestOptions {
  [key: string]: unknown;
}

interface IngestInputBase {
  scope: TenantScope;
  source: IngestSource;
  sourceKey: string;
  filename: string;
  mimeType: string;
  docType?: DocType;
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
  parseJob: { parser: string; jobId: string; submittedAt: string; attempt: number } | null;
  artifacts: Record<string, string>;
  docTypeDetection: { signals: string[]; refined: DocType | null; reparsed: boolean } | null;
  quarantine: { ruleIds: string[]; released: boolean } | null;
  invoice: { extractor: string; status: string } | null;
  images: { nextIndex: number; captioned: number } | null;
  embeddingTargets: string[];
  embeddingGaps: Array<{ profileId: string; chunkIndex: number }>;
}

export function emptyIngestState(): IngestState {
  return {
    lastCompleted: null,
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

export type ChunkKind = 'text' | 'table';

/** A chunk as the chunker produces it: plain content, never prefixed with its path or document name. */
export interface ChunkDraft {
  content: string;
  section_path: string[];
  chunk_kind: ChunkKind;
  page_start: number | null;
  page_end: number | null;
  metadata: Record<string, unknown>;
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
  resumed: boolean;
}

/** Working data of one run. Not persisted; plan 03-13b moves what a resume needs into the object store. */
export interface IngestWork {
  parseText: string | null;
  parserVersion: string | null;
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

export type StageOutcome =
  | { kind: 'next' }
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
