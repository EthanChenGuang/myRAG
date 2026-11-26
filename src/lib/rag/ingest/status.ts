import { UploadApprovalSchema } from '@/lib/rag-eval/contracts.generated';
import { validHiddenTextReport } from '../security/hidden-text';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { isTerminal } from './callbacks/common';
import { loadIngestConfig } from './config';
import { getIngestDeps } from './deps';
import { getJobForDocument } from './ledger';
import { ObjectStoreError } from './object-store';
import { getProcessingProfile, profileFor, type DocType, type ProcessingProfile } from './profiles/load';
import { INGEST_STAGES, REGISTERED_STAGES, nextStageAfter, rehydrateFromStore, runIngestStages } from './runner';
import { createIngestTrace, finishIngestTrace } from './trace';
import {
  DEFAULT_INGEST_DEADLINE_MS,
  INGEST_SOURCES,
  type EmbedProgress,
  emptyIngestState,
  type DocTypeOrigin,
  type HiddenTextState,
  type IngestResult,
  type IngestSource,
  type IngestState,
  type RehydrateResult,
  type StageContext,
  type StageName,
  type TypeChangeState,
} from './types';
import { IngestWriterError, createIngestWriter, type IngestDocumentRow, type IngestOriginRow, type IngestWriter } from './writer';

export interface IngestStatusView {
  status: string;
  version: number;
  processingStatus: string | null;
  lastCompleted: StageName | null;
  parserUsed: string | null;
  docType: string;
}

export interface ResumeIngestOptions {
  signal?: AbortSignal;
  /** Request budget for the resumed run. Defaults to DEFAULT_INGEST_DEADLINE_MS. */
  deadlineMs?: number;
  /**
   * Single-tenant non-administrator callers: the session user, who must be the uploader the version recorded. Any other
   * version (another uploader, or none recorded) reads exactly like an unknown id and nothing runs.
   */
  requireUploader?: string;
}

const LOOKUP_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGINS: readonly DocTypeOrigin[] = ['picked', 'source_default', 'tenant_default', 'auto', 'fallback'];

function isStageName(value: unknown): value is StageName {
  return typeof value === 'string' && (INGEST_STAGES as readonly string[]).includes(value);
}

function lastCompletedOf(state: Record<string, unknown>): StageName | null {
  return isStageName(state.lastCompleted) ? state.lastCompleted : null;
}

function writerFor(scope: TenantScope, signal: AbortSignal): IngestWriter | null {
  const db = getIngestDeps().db();
  return db ? createIngestWriter({ db, scope, signal }) : null;
}

function failed(reason: string, documentId: string | null = null, version: number | null = null): IngestResult {
  return { status: 'failed', documentId, version, parserUsed: null, chunkCount: 0, warnings: [], reason };
}

export interface IngestStatusReport {
  view: IngestStatusView;
  /** Short codes only, never document text. */
  warnings: string[];
  /** The short failure code of a failed version. */
  reason: string | null;
  /** Present when a ledger row exists for this document. */
  jobId?: string;
  jobStatus?: string;
  provisional?: boolean;
}

/** A version that has been processing for longer than this is failed by the next status read; there is no worker until Phase 3.1. */
export const STALE_PROCESSING_MS = 24 * 60 * 60 * 1000;
export const STALE_PROCESSING_REASON = 'stale_processing';

const REASON_CODE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/;

function failureCodeOf(state: Record<string, unknown>): string | null {
  const reason = state.failure_reason;
  return typeof reason === 'string' && REASON_CODE.test(reason) ? reason : null;
}

function warningsOf(row: IngestDocumentRow): string[] {
  const warnings: string[] = [];
  if (row.status === 'processing' && objectOf(row.processingState.parseJob)) warnings.push('parse_pending');
  if (Array.isArray(row.processingState.embeddingGaps) && row.processingState.embeddingGaps.length > 0) warnings.push('embedding_gaps');
  return warnings;
}

/** Only a processing row with a readable creation time strictly older than 24 hours is stale; anything else is left alone. */
function isStale(row: IngestDocumentRow, now: number): boolean {
  if (row.status !== 'processing') return false;
  const created = Date.parse(row.createdAt);
  return Number.isFinite(created) && now - created > STALE_PROCESSING_MS;
}

/**
 * The status of one document of the caller's tenant, read through the tenant-checked writer function.
 * An id that is not a UUID, does not exist or belongs to another tenant returns null.
 *
 * This read is also the reaper: a version of the caller's own tenant that has been processing for more than
 * 24 hours is marked failed (reason stale_processing) and reported as failed. A failed version is not resumed;
 * uploading the file again starts a new version. The reaper touches nothing else and logs the id and the age only.
 */
export async function getIngestStatusReport(
  scope: TenantScope,
  documentId: string,
  options: ResumeIngestOptions = {},
): Promise<IngestStatusReport | null> {
  try {
    assertTenantScope(scope);
  } catch {
    return null;
  }
  if (!UUID.test(documentId)) return null;
  const writer = writerFor(scope, options.signal ?? AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
  if (!writer) throw new IngestWriterError('rag_get_ingest_document', 'db_unavailable');
  const row = await writer.getDocument(documentId);
  if (!row) return null;

  const view: IngestStatusView = {
    status: row.status,
    version: row.version,
    processingStatus: row.processingStatus,
    lastCompleted: lastCompletedOf(row.processingState),
    parserUsed: row.parserUsed,
    docType: row.docType,
  };
  const signal = options.signal ?? AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  let ledgerExtras: Pick<IngestStatusReport, 'jobId' | 'jobStatus' | 'provisional'> | undefined;
  let ledgerBlocksReaper = false;
  let ledgerFailureReason: string | null = null;
  const job = await getJobForDocument(scope, documentId, { signal });
  if (job) {
    ledgerExtras = {
      jobId: job.id,
      jobStatus: job.status,
      provisional: job.provisional_published_at != null,
    };
    if (!isTerminal(job)) ledgerBlocksReaper = true;
    if (job.status === 'failed' && typeof job.error_class === 'string' && REASON_CODE.test(job.error_class)) {
      ledgerFailureReason = job.error_class;
    }
  }

  if (ledgerFailureReason) {
    return {
      view: { ...view, status: 'failed', processingStatus: 'failed' },
      warnings: [],
      reason: ledgerFailureReason,
      ...ledgerExtras,
    };
  }

  const now = getIngestDeps().now();
  if (isStale(row, now) && !ledgerBlocksReaper) {
    try {
      await writer.markFailed(documentId, STALE_PROCESSING_REASON);
      console.warn('[Ingest] reaped stale processing version', {
        documentId,
        ageHours: Math.floor((now - Date.parse(row.createdAt)) / 3_600_000),
      });
      return {
        view: { ...view, status: 'failed', processingStatus: 'failed' },
        warnings: [],
        reason: STALE_PROCESSING_REASON,
        ...ledgerExtras,
      };
    } catch (error) {
      console.error('[Ingest] could not reap a stale processing version', {
        documentId,
        error: error instanceof Error ? error.name : 'unknown',
        ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
      });
    }
  }
  return {
    view,
    warnings: warningsOf(row),
    reason: row.status === 'failed' ? failureCodeOf(row.processingState) : null,
    ...ledgerExtras,
  };
}

export async function getIngestStatus(
  scope: TenantScope,
  documentId: string,
  options: ResumeIngestOptions = {},
): Promise<IngestStatusView | null> {
  return (await getIngestStatusReport(scope, documentId, options))?.view ?? null;
}

function objectOf<T>(value: unknown): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : null;
}

const REUSED_PARSERS = ['docling', 'llamaparse', 'text'] as const;

/** The type-change slice of a saved state; anything that does not have the shape this code wrote is dropped. */
function typeChangeOf(value: unknown): TypeChangeState | null {
  const slice = objectOf<Record<string, unknown>>(value);
  if (!slice) return null;
  const version = slice.reuseParseOfVersion;
  if (version !== null && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) return null;
  const parser = objectOf<Record<string, unknown>>(slice.reusedParser);
  const reused =
    parser && REUSED_PARSERS.some((name) => name === parser.parser) && typeof parser.version === 'string' && parser.version !== ''
      ? { parser: parser.parser as (typeof REUSED_PARSERS)[number], version: parser.version }
      : null;
  return { reuseParseOfVersion: version, reusedParser: reused, ...(slice.sanitizedParse === true ? { sanitizedParse: true } : {}) };
}

/** The hidden-text slice of a saved state; a report that does not validate is dropped, so a retried scan asks the sidecar again. */
function hiddenTextOf(value: unknown): HiddenTextState | null {
  const slice = objectOf<Record<string, unknown>>(value);
  if (!slice || typeof slice.fileSha256 !== 'string') return null;
  const report = slice.report === null ? null : validHiddenTextReport(slice.report);
  if (slice.report !== null && report === null) return null;
  const removedSpans = Array.isArray(slice.removedSpans) ? slice.removedSpans.filter((span): span is string => typeof span === 'string') : [];
  const unlocated = typeof slice.unlocated === 'number' && Number.isInteger(slice.unlocated) && slice.unlocated >= 0 ? slice.unlocated : 0;
  return { fileSha256: slice.fileSha256, report, removedSpans, unlocated, sanitized: slice.sanitized === true };
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function embedProgressOf(value: unknown): EmbedProgress | null {
  const slice = objectOf<Record<string, unknown>>(value);
  if (!slice || !isCount(slice.batchesDone) || !isCount(slice.written) || !isCount(slice.total)) return null;
  if (!Array.isArray(slice.targets) || !slice.targets.every((id) => typeof id === 'string')) return null;
  if (!Array.isArray(slice.gaps)) return null;
  const gaps: EmbedProgress['gaps'] = [];
  for (const gap of slice.gaps) {
    const entry = objectOf<Record<string, unknown>>(gap);
    if (!entry || typeof entry.profileId !== 'string' || !isCount(entry.chunkIndex)) return null;
    gaps.push({ profileId: entry.profileId, chunkIndex: entry.chunkIndex });
  }
  return { batchesDone: slice.batchesDone, written: slice.written, total: slice.total, targets: slice.targets as string[], gaps };
}

/** A persisted state record (a document row's processing_state or a ledger row's stage_state), with every slice checked for shape; anything unreadable falls back to its empty value. */
export function ingestStateFromRecord(raw: Record<string, unknown>): IngestState {
  const state = emptyIngestState();
  state.lastCompleted = lastCompletedOf(raw);
  state.chunkCount = typeof raw.chunkCount === 'number' && Number.isInteger(raw.chunkCount) && raw.chunkCount >= 0 ? raw.chunkCount : null;
  state.docTypeOrigin = ORIGINS.find((origin) => origin === raw.docTypeOrigin) ?? null;
  state.parseJob = objectOf<NonNullable<IngestState['parseJob']>>(raw.parseJob);
  state.artifacts = objectOf<IngestState['artifacts']>(raw.artifacts) ?? {};
  state.docTypeDetection = objectOf<NonNullable<IngestState['docTypeDetection']>>(raw.docTypeDetection);
  state.quarantine = objectOf<NonNullable<IngestState['quarantine']>>(raw.quarantine);
  state.invoice = objectOf<NonNullable<IngestState['invoice']>>(raw.invoice);
  state.images = objectOf<NonNullable<IngestState['images']>>(raw.images);
  const typeChange = typeChangeOf(raw.typeChange);
  if (typeChange) state.typeChange = typeChange;
  if (Array.isArray(raw.embeddingTargets)) state.embeddingTargets = raw.embeddingTargets.filter((id): id is string => typeof id === 'string');
  if (Array.isArray(raw.embeddingGaps)) state.embeddingGaps = raw.embeddingGaps as IngestState['embeddingGaps'];
  if (raw.approval !== undefined && raw.approval !== null) {
    const approval = UploadApprovalSchema.safeParse(raw.approval);
    // A stored decision that does not validate is kept as "approval required": a resumed run can only hold, never skip the gate.
    state.approval = approval.success
      ? approval.data
      : { mode: 'all', required: true, reason: 'unknown_uploader', uploader_id: null, decided_at: new Date(0).toISOString() };
  }
  const hiddenText = hiddenTextOf(raw.hiddenText);
  if (hiddenText) state.hiddenText = hiddenText;
  if (typeof raw.uploaderId === 'string' && UUID.test(raw.uploaderId)) state.uploaderId = raw.uploaderId.toLowerCase();
  const embedProgress = embedProgressOf(raw.embedProgress);
  if (embedProgress) state.embedProgress = embedProgress;
  const hold = objectOf<{ batchId?: unknown }>(raw.publishHold);
  if (hold && typeof hold.batchId === 'string' && hold.batchId !== '') state.publishHold = { batchId: hold.batchId };
  return state;
}

function stateOf(row: IngestDocumentRow): IngestState {
  return ingestStateFromRecord(row.processingState);
}

function settledResult(row: IngestDocumentRow, state: IngestState, documentId: string): IngestResult | null {
  if (row.status === 'ready' || row.status === 'quarantined' || row.status === 'pending_review') {
    return {
      status: row.status,
      documentId,
      version: row.version,
      parserUsed: row.parserUsed,
      chunkCount: state.chunkCount ?? 0,
      warnings: [],
    };
  }
  if (row.status === 'failed') {
    const reason = typeof row.processingState.failure_reason === 'string' ? row.processingState.failure_reason : 'failed';
    return failed(reason, documentId, row.version);
  }
  if (row.status === 'deleted') return failed('document_deleted', documentId, row.version);
  return null;
}

function profileOf(docType: string, source: IngestSource, warnings: string[]): { docType: DocType; profile: ProcessingProfile } {
  try {
    return { docType: docType as DocType, profile: profileFor(source, docType as DocType) };
  } catch {
    warnings.push('doc_type_invalid');
    return { docType: 'general', profile: getProcessingProfile('general') };
  }
}

function sourceOf(value: string | null): IngestSource {
  return INGEST_SOURCES.find((source) => source === value) ?? 'config_upload';
}

/** A resumed run carries no upload: stages after file_hash_dedup read the document row and the rebuilt work, never the input. */
function resumeContext(
  scope: TenantScope,
  documentId: string,
  row: IngestDocumentRow,
  origin: IngestOriginRow | null,
  state: IngestState,
  writer: IngestWriter,
  signal: AbortSignal,
  deadlineMs: number,
): StageContext {
  const deps = getIngestDeps();
  const warnings: string[] = [];
  const source = sourceOf(origin?.source ?? null);
  const { docType, profile } = profileOf(row.docType, source, warnings);
  return {
    input: { scope, source, sourceKey: origin?.sourceKey ?? '', filename: row.filename, mimeType: '', file: new Uint8Array(0), signal },
    deps,
    writer,
    config: loadIngestConfig(deps.ingestEnv()),
    signal,
    deadline: deps.now() + deadlineMs,
    state,
    warnings,
    identity: {
      tenantKey: scopeKey(scope).toLowerCase(),
      filename: row.filename,
      fileSha256: '',
      docType,
      docTypeOrigin: state.docTypeOrigin ?? 'fallback',
      profile,
      bytes: null,
    },
    document: { id: documentId, version: row.version, lineageId: origin?.lineageId ?? '', originalPath: origin?.originalPath ?? null, resumed: true },
    parserUsed: row.parserUsed,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  };
}

/**
 * Continues a document of the caller's tenant from the stage after lastCompleted. A ready, quarantined,
 * failed or deleted document returns its settled result without running a stage. A processing document
 * needs its stage inputs back first (deps.rehydrate, by default rehydrateFromStore, which reads the stored
 * original and parse output); when they cannot be rebuilt the call reports processing with
 * resume_input_unavailable and writes nothing, and when the original is gone it fails as original_unavailable. Chunk ids derive from
 * the document id and chunk index, so a repeated resume rewrites the same rows.
 */
export async function resumeIngest(scope: TenantScope, documentId: string, options: ResumeIngestOptions = {}): Promise<IngestResult> {
  try {
    assertTenantScope(scope);
  } catch {
    return failed('invalid_scope');
  }
  if (!UUID.test(documentId)) return failed('document_not_found');
  const blocked = loadIngestConfig(getIngestDeps().ingestEnv()).pipelineBlocked;
  if (blocked) return failed(blocked);
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_INGEST_DEADLINE_MS);
  const writer = writerFor(scope, signal);
  if (!writer) {
    console.error('[Ingest] admin client unavailable');
    return failed('db_unavailable');
  }

  let row: IngestDocumentRow | null;
  try {
    row = await writer.getDocument(documentId);
  } catch (error) {
    console.error('[Ingest] resume lookup failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
    });
    return failed('resume_lookup_failed');
  }
  if (!row) return failed('document_not_found');

  const state = stateOf(row);
  if (options.requireUploader !== undefined && (state.uploaderId === undefined || state.uploaderId !== options.requireUploader.toLowerCase())) {
    return failed('document_not_found');
  }
  const settled = settledResult(row, state, documentId);
  if (settled) return settled;

  const processing = (reason: string): IngestResult => ({
    status: 'processing',
    documentId,
    version: row.version,
    parserUsed: row.parserUsed,
    chunkCount: 0,
    warnings: [],
    reason,
  });
  if (nextStageAfter(state.lastCompleted) === null || state.lastCompleted === null) return processing('resume_state_missing');

  let origin: IngestOriginRow | null;
  try {
    origin = await writer.getOrigin(documentId);
  } catch (error) {
    console.error('[Ingest] resume lookup failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
    });
    return failed('resume_lookup_failed');
  }
  const ctx = resumeContext(scope, documentId, row, origin, state, writer, signal, options.deadlineMs ?? DEFAULT_INGEST_DEADLINE_MS);
  const rehydrate = ctx.deps.rehydrate ?? rehydrateFromStore;
  let rebuilt: RehydrateResult;
  try {
    rebuilt = await rehydrate(ctx);
  } catch (error) {
    console.error('[Ingest] could not rebuild the stage inputs', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(error instanceof ObjectStoreError ? { op: error.op, status: error.status } : {}),
    });
    return processing('resume_input_unavailable');
  }
  if (rebuilt === false) return processing('resume_input_unavailable');
  if (typeof rebuilt === 'object') {
    try {
      await writer.markFailed(documentId, rebuilt.failed);
    } catch (error) {
      console.error('[Ingest] could not mark the version failed', {
        error: error instanceof Error ? error.name : 'unknown',
        ...(error instanceof IngestWriterError ? { rpc: error.rpc, code: error.code } : {}),
      });
    }
    return failed(rebuilt.failed, documentId, row.version);
  }

  const trace = createIngestTrace(scope);
  const result = await runIngestStages(ctx, REGISTERED_STAGES, { trace });
  if (trace) finishIngestTrace(trace, result);
  return result;
}
