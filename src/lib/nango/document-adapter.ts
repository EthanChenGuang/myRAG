import { processDocument } from '@/lib/document-processor';
import { logger } from '@/lib/logger';
import {
  buildSourceKey,
  currentIngestConfig,
  ingest,
  nangoOwnerScope,
  submitIngest,
  type EnqueueResult,
  type IngestInput,
  type IngestResult,
} from '@/lib/rag';

function nangoAsyncIngestEnabled(): boolean {
  return (
    (process.env.RAG_INGEST_PIPELINE ?? 'legacy').toLowerCase() === 'unified' &&
    (process.env.RAG_INGEST_ASYNC ?? 'off').toLowerCase() === 'on'
  );
}

/**
 * Options for processing documents with source tracking
 */
export interface ProcessDocumentOptions {
  /** The connection owner, read by the sync manager from the nango_connections row; never a request or webhook value. */
  userId: string;
  source?: 'upload' | 'nango';
  sourceProvider?: string;
  sourceFileId?: string;
  sourceConnectionId?: string;
  /** Unified pipeline only: the connection and folder ids the admin doc-type defaults can name. */
  nangoConnectionId?: string;
  nangoFolderId?: string;
  mimeType?: string;
  signal?: AbortSignal;
}

export type NangoPipeline = 'legacy' | 'unified';

/** A Nango file that the unified pipeline did not turn into a document; `reason` is stable, `status` is set for a refused owner. */
export class NangoIngestError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(reason: string, status?: number) {
    super(`[Nango Ingest] ${reason}`);
    this.name = 'NangoIngestError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Which write path a sync takes, read per call. A configuration that cannot be read resolves to the legacy path,
 * which is today's behaviour.
 */
export function nangoPipeline(): NangoPipeline {
  try {
    return currentIngestConfig().pipeline === 'unified' ? 'unified' : 'legacy';
  } catch {
    logger.warn('Nango', 'ingest switch unavailable, using the legacy pipeline');
    return 'legacy';
  }
}

const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
// Google Docs, Sheets and Slides are exported as PDF by the file fetcher, so the bytes are a PDF whatever the Drive type says.
const GOOGLE_EXPORT_MIME = 'application/pdf';

const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const MIME_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

function ingestMimeType(filename: string, mimeType: string | undefined): string {
  const declared = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared.startsWith(GOOGLE_NATIVE_PREFIX)) return GOOGLE_EXPORT_MIME;
  if (declared !== '' && declared !== 'application/octet-stream') return declared;
  return EXTENSION_MIME[extensionOf(filename)] ?? 'application/octet-stream';
}

// The parsers choose by file extension first, so the name must carry the extension of the bytes that are stored
// (a Notion page title with a dot in it, or a Google Doc exported as PDF, would otherwise select no parser).
function ingestFilename(filename: string, mimeType: string): string {
  const expected = MIME_EXTENSION[mimeType];
  if (!expected || extensionOf(filename) === expected) return filename;
  return `${filename}.${expected}`;
}

// ingest() ends a slow file as processing; the sync waits for it per file, then the next sync resumes it.
const INGEST_DEADLINE_MS = 50000;
const SIGNAL_GRACE_MS = 10000;

/**
 * Process a document and store it with source metadata.
 * Legacy: the existing document processor. Unified: ingest() in the scope of the connection owner, with the provider
 * file id as the document's identity, so an unchanged file is skipped and a changed one becomes a new version.
 */
export async function processDocumentWithMetadata(
  filename: string,
  buffer: Buffer,
  options: ProcessDocumentOptions
): Promise<string> {
  logger.debug('Nango', `Processing document with metadata: ${filename}`);

  if (nangoPipeline() === 'unified') {
    return ingestNangoDocument(filename, buffer, options);
  }

  // Use the existing document processor with all metadata including user_id
  // Stored sources include 'nango' although the processor's declared union omits it
  const metadata = {
    user_id: options.userId,
    source: options.source || 'nango',
    source_provider: options.sourceProvider,
    source_file_id: options.sourceFileId,
    source_connection_id: options.sourceConnectionId,
  } as Parameters<typeof processDocument>[2];
  const documentId = await processDocument(filename, buffer, metadata);

  logger.debug('Nango', `Processed document ${documentId} with source metadata`);
  return documentId;
}

async function ingestNangoDocument(filename: string, buffer: Buffer, options: ProcessDocumentOptions): Promise<string> {
  const sourceFileId = options.sourceFileId;
  if (typeof sourceFileId !== 'string' || sourceFileId.trim() === '') {
    throw new NangoIngestError('missing_file_id');
  }

  const owner = nangoOwnerScope({ ownerUserId: options.userId });
  if (!owner.ok) throw new NangoIngestError(owner.reason, owner.status);

  const mimeType = ingestMimeType(filename, options.mimeType);
  const ingestInput: IngestInput = {
    scope: owner.scope,
    source: 'nango',
    sourceKey: buildSourceKey('nango', { providerFileId: sourceFileId }),
    // The connection owner, from the server's connection record: the uploader of a synced item (D-37).
    uploaderId: options.userId,
    file: buffer,
    filename: ingestFilename(filename, mimeType),
    mimeType,
    options: {
      origin: {
        sourceProvider: options.sourceProvider,
        sourceFileId,
        sourceConnectionId: options.sourceConnectionId,
      },
      nangoConnectionId: options.nangoConnectionId,
      nangoFolderId: options.nangoFolderId,
    },
    signal: options.signal ?? AbortSignal.timeout(INGEST_DEADLINE_MS + SIGNAL_GRACE_MS),
    deadlineMs: INGEST_DEADLINE_MS,
  };
  const result: IngestResult | EnqueueResult = nangoAsyncIngestEnabled()
    ? await submitIngest(ingestInput)
    : await ingest(ingestInput);

  if (result.status === 'failed') throw new NangoIngestError(result.reason ?? 'ingest_failed');
  // Not finished: the sync record stays unsynced, and the next sync of the same bytes resumes the stored run.
  if (result.status === 'processing') throw new NangoIngestError(result.reason ?? 'ingest_processing');

  const documentId =
    result.documentId ?? ('duplicateOf' in result ? result.duplicateOf : undefined) ?? null;
  if (documentId === null) throw new NangoIngestError(`no_document_${result.status}`);

  if (result.status === 'quarantined') {
    logger.warn('Nango', 'A synced file was quarantined by the injection scan and is not searchable');
  }
  logger.debug('Nango', `Ingested ${result.status} document ${documentId}`);
  return documentId;
}
