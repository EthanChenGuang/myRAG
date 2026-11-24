import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import { isArtifactName, loadArtifact, versionPrefix, type ArtifactContext } from './artifacts';
import { getIngestDeps } from './deps';
import { submitIngest } from './enqueue';
import { queueConfigFromProcessEnv } from './queue-config';
import { DOC_TYPE_IDS } from './profiles/doc-type-defaults';
import { profileFor, type DocType } from './profiles/load';
import { storedParseServes } from './profiles/resolve-doc-type';
import { INGEST_SOURCES, type IngestOptions, type IngestOrigin, type IngestResult, type IngestSource, type TypeChangeState } from './types';

export type ChangeDocumentTypeFailure = 'not_found' | 'not_changeable' | 'original_unavailable' | 'invalid_doc_type' | 'unavailable';

export interface ChangeDocumentTypeInput {
  /** The tenant of the document, from a resolver; a document of any other tenant is reported as not_found. */
  scope: TenantScope;
  documentId: string;
  docType: DocType;
  signal: AbortSignal;
  /** Request budget for the run. Defaults to the ingest default. */
  deadlineMs?: number;
}

export type ChangeDocumentTypeResult = { ok: true; result: IngestResult } | { ok: false; reason: ChangeDocumentTypeFailure };

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REUSABLE_PARSERS = ['docling', 'llamaparse', 'text'] as const;

const fail = (reason: ChangeDocumentTypeFailure): ChangeDocumentTypeResult => ({ ok: false, reason });

function text(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function objectOf(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

function isDocType(value: string | null): value is DocType {
  return value !== null && (DOC_TYPE_IDS as readonly string[]).includes(value);
}

function sourceOf(value: string | null): IngestSource | null {
  return INGEST_SOURCES.find((source) => source === value) ?? null;
}

/** What the new version carries over from the one it replaces: the origin fields, the caller metadata and, for a picture, its URL and context. */
function optionsOf(row: Row): IngestOptions {
  const origin: IngestOrigin = {};
  const provider = text(row, 'source_provider');
  const fileId = text(row, 'source_file_id');
  const connectionId = text(row, 'source_connection_id');
  if (provider !== null) origin.sourceProvider = provider;
  if (fileId !== null) origin.sourceFileId = fileId;
  if (connectionId !== null) origin.sourceConnectionId = connectionId;

  const options: IngestOptions = { origin, documentMetadata: objectOf(row.metadata) ?? {} };
  const images = objectOf(objectOf(row.processing_state)?.images);
  const imageUrl = images ? text(images, 'imageUrl') : null;
  const imageContext = images ? text(images, 'imageContext') : null;
  if (imageUrl !== null) options.imageUrl = imageUrl;
  if (imageContext !== null) options.imageContext = imageContext;
  return options;
}

/** The part of the saved state this run needs from the version it replaces; reuse needs a valid profile id, a known parser and a version. */
function typeChangeOf(row: Row, source: IngestSource, from: DocType, to: DocType, version: number): TypeChangeState {
  const stored = profileFor(source, from);
  const parser = REUSABLE_PARSERS.find((name) => name === text(row, 'parser_used'));
  const parserVersion = text(row, 'parser_version');
  const reusable =
    parser !== undefined && parserVersion !== null && text(row, 'processing_profile_id') === stored.id && storedParseServes(stored, profileFor(source, to));
  return reusable ? { reuseParseOfVersion: version, reusedParser: { parser, version: parserVersion } } : { reuseParseOfVersion: null, reusedParser: null };
}

async function readDocument(scope: TenantScope, documentId: string, signal: AbortSignal): Promise<Row | null | 'unavailable'> {
  const db = getIngestDeps().db();
  if (!db) {
    console.error('[Ingest] admin client unavailable');
    return 'unavailable';
  }
  try {
    signal.throwIfAborted();
    const response = await db.rpc('rag_get_document_for_type_change', { p_document_id: documentId.toLowerCase(), p_tenant_key: scopeKey(scope).toLowerCase() }).abortSignal(signal);
    signal.throwIfAborted();
    if (response.error) {
      console.error('[Ingest] type change lookup failed', { code: response.error.code ?? null });
      return 'unavailable';
    }
    return ((response.data ?? [])[0] as Row | undefined) ?? null;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error('[Ingest] type change lookup failed', { error: error instanceof Error ? error.name : 'unknown' });
    return 'unavailable';
  }
}

/**
 * Re-runs ingest() on the same identity with a new type, as a new version through the D-11 swap (D-18). The file bytes come from the stored
 * original, so the caller sends nothing. When the stored parse output is valid for the new type's parser options (storedParseServes), the run
 * starts from it and calls no parser; otherwise the stored original is parsed again. The unchanged file hash and content hash do not skip
 * the run: it carries the forced-version state, which only this function sets. A document of another tenant, an unknown id and a document
 * that is not the current ready version create nothing. The caller must have passed the admin guard; the version it creates keeps the
 * owner and the organization of the one it replaces.
 */
export async function changeDocumentType(input: ChangeDocumentTypeInput): Promise<ChangeDocumentTypeResult> {
  const { scope, documentId, docType, signal } = input;
  try {
    assertTenantScope(scope);
  } catch {
    return fail('unavailable');
  }
  if (!UUID.test(documentId)) return fail('not_found');
  if (!isDocType(docType)) return fail('invalid_doc_type');

  const row = await readDocument(scope, documentId, signal);
  if (row === 'unavailable') return fail('unavailable');
  if (row === null) return fail('not_found');
  if (row.is_current !== true || row.status !== 'ready') return fail('not_changeable');

  const lineageId = text(row, 'lineage_id');
  const version = typeof row.version === 'number' && Number.isInteger(row.version) ? row.version : null;
  const originalPath = text(row, 'original_path');
  if (lineageId === null || version === null || originalPath === null) return fail('original_unavailable');
  const tenantKey = scopeKey(scope).toLowerCase();
  let prefix: string;
  try {
    prefix = versionPrefix(tenantKey, lineageId, version);
  } catch {
    return fail('original_unavailable');
  }
  const name = originalPath.startsWith(prefix) ? originalPath.slice(prefix.length) : '';
  if (!isArtifactName(name)) return fail('original_unavailable');

  const source = sourceOf(text(row, 'source'));
  const sourceKey = text(row, 'source_key');
  if (source === null || sourceKey === null) return fail('not_changeable');
  const previousType = text(row, 'doc_type');
  if (!isDocType(previousType)) return fail('not_changeable');

  const artifactCtx: ArtifactContext = { identity: { tenantKey }, document: { lineageId, version }, signal, state: { artifacts: {} } };
  let original;
  try {
    original = await loadArtifact(artifactCtx, name);
  } catch (error) {
    if (signal.aborted) throw error;
    console.error('[Ingest] type change could not read the original', { error: error instanceof Error ? error.name : 'unknown' });
    return fail('unavailable');
  }
  if (original === null) return fail('original_unavailable');

  const outcome = await submitIngest(
    {
      scope,
      source,
      sourceKey,
      filename: text(row, 'filename') ?? sourceKey,
      mimeType: original.contentType || 'application/octet-stream',
      file: original.bytes,
      docType,
      options: optionsOf(row),
      typeChange: typeChangeOf(row, source, previousType, docType, version),
      signal,
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
    },
    { queueConfig: queueConfigFromProcessEnv },
  );
  if ('jobId' in outcome) {
    return {
      ok: true,
      result: {
        status: 'processing',
        documentId: outcome.documentId,
        version: null,
        parserUsed: null,
        chunkCount: 0,
        warnings: [],
      },
    };
  }
  return { ok: true, result: outcome };
}
