import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { loadIngestConfig } from './config';
import { getIngestDeps } from './deps';
import { ObjectStoreError } from './object-store';
import { getProcessingProfile, profileFor, type DocType, type ProcessingProfile } from './profiles/load';
import { INGEST_STAGES, REGISTERED_STAGES, nextStageAfter, rehydrateFromStore, runIngestStages } from './runner';
import { createIngestTrace, finishIngestTrace } from './trace';
import {
  DEFAULT_INGEST_DEADLINE_MS,
  INGEST_SOURCES,
  emptyIngestState,
  type DocTypeOrigin,
  type IngestResult,
  type IngestSource,
  type IngestState,
  type RehydrateResult,
  type StageContext,
  type StageName,
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

/**
 * The status of one document of the caller's tenant, read through the tenant-checked writer function.
 * An id that is not a UUID, does not exist or belongs to another tenant returns null.
 */
export async function getIngestStatus(
  scope: TenantScope,
  documentId: string,
  options: ResumeIngestOptions = {},
): Promise<IngestStatusView | null> {
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
  return {
    status: row.status,
    version: row.version,
    processingStatus: row.processingStatus,
    lastCompleted: lastCompletedOf(row.processingState),
    parserUsed: row.parserUsed,
    docType: row.docType,
  };
}

function objectOf<T>(value: unknown): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : null;
}

/** The persisted state of a row, with every slice checked for shape; anything unreadable falls back to its empty value. */
function stateOf(row: IngestDocumentRow): IngestState {
  const raw = row.processingState;
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
  if (Array.isArray(raw.embeddingTargets)) state.embeddingTargets = raw.embeddingTargets.filter((id): id is string => typeof id === 'string');
  if (Array.isArray(raw.embeddingGaps)) state.embeddingGaps = raw.embeddingGaps as IngestState['embeddingGaps'];
  return state;
}

function settledResult(row: IngestDocumentRow, state: IngestState, documentId: string): IngestResult | null {
  if (row.status === 'ready' || row.status === 'quarantined') {
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
