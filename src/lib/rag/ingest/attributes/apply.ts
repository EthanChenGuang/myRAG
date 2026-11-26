import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import type { TenantScope } from '../../tenant/scope';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';
import { IngestStageError, type IngestAttributeValues, type StageContext } from '../types';
import { docAttributesEnabled, loadAttributeSchema } from './schema';
import { validateAttributes, type AttributeError } from './validate';

/**
 * Attribute values on every write path (TPL-03, D-22, D-23): the route-side check, the stage hook that applies a begun version's values
 * before any chunk is written, and thin wrappers of the migration 1005 functions. Attributes that arrive while the feature is effectively
 * off are rejected with attributes_not_enabled, never ignored. Values never leave this module in a log, trace, stage detail or error:
 * those carry document ids, counts and code words only.
 */

const LOG = '[Ingest]';
const STAGE_BATCH = 500;

export type AttributeOrigin = 'explicit' | 'staged' | 'inherited' | 'none';

export type ValidateUploadAttributesResult =
  /** attributes is undefined when the request carries no attributes field. */
  | { ok: true; attributes: IngestAttributeValues | undefined }
  | { ok: false; reason: 'attributes_not_enabled' }
  | { ok: false; reason: 'invalid_attributes'; errors: AttributeError[] }
  | { ok: false; reason: 'unavailable' };

/**
 * Route-side check, before anything is stored. raw is the form field as sent (a JSON object), or null/undefined when the field is absent:
 * then nothing is read. A present field while RAG_DOC_ATTRIBUTES is effectively off is attributes_not_enabled; malformed JSON or a value
 * that is not an object is invalid_attributes with one error; otherwise validateAttributes against the scope's own tenant schema.
 */
export async function validateUploadAttributes(
  scope: TenantScope,
  raw: string | null | undefined,
  options: { signal: AbortSignal; config?: Pick<IngestConfig, 'docAttributes'> },
): Promise<ValidateUploadAttributesResult> {
  if (raw === null || raw === undefined) return { ok: true, attributes: undefined };
  const config = options.config ?? currentIngestConfig();
  if (!config.docAttributes) return { ok: false, reason: 'attributes_not_enabled' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_attributes', errors: [{ key: '', code: 'invalid_attribute_type' }] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_attributes', errors: [{ key: '', code: 'invalid_attribute_type' }] };
  }
  const schema = await loadAttributeSchema(scope, { signal: options.signal });
  if (!schema.ok) return { ok: false, reason: 'unavailable' };
  const checked = validateAttributes(schema.definitions, parsed);
  if (!checked.ok) return { ok: false, reason: 'invalid_attributes', errors: checked.errors };
  return { ok: true, attributes: checked.values };
}

/** Code words of the 1005 functions that pass through unchanged; any other database error is attribute_write_failed. */
const SQL_REASONS = new Set([
  'unknown_attribute',
  'invalid_attribute_type',
  'too_many_values',
  'value_too_long',
  'not_found',
  'invalid_argument',
]);

function reasonOf(error: { message?: string | null }, fallback: string): string {
  const word = /^[a-z_]+/.exec(error.message ?? '')?.[0];
  return word !== undefined && SQL_REASONS.has(word) ? word : fallback;
}

function isOrigin(value: unknown): value is AttributeOrigin {
  return value === 'explicit' || value === 'staged' || value === 'inherited' || value === 'none';
}

/**
 * Applies the values of a version that is still being ingested (rag_apply_document_attributes): explicit values when given, else the row
 * staged for its source key, else the lineage's current value. Used by file_hash_dedup and by the progressive final begin.
 */
export async function writeDocumentAttributes(
  db: RpcClient,
  tenantKey: string,
  documentId: string,
  explicit: IngestAttributeValues | undefined,
  signal: AbortSignal,
  _options: { config?: IngestConfig } = {},
): Promise<{ origin: AttributeOrigin; keyCount: number }> {
  signal.throwIfAborted();
  const response = await db
    .rpc('rag_apply_document_attributes', { p_tenant_key: tenantKey, p_document_id: documentId, p_explicit: explicit ?? null })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    const reason = reasonOf(response.error, 'attribute_write_failed');
    console.error(`${LOG} document attributes not stored`, { documentId, reason, code: response.error.code ?? null });
    throw new IngestStageError('file_hash_dedup', reason);
  }
  const row = (rpcRows(response.data) as Array<Record<string, unknown>>)[0];
  const origin = isOrigin(row?.origin) ? row.origin : 'none';
  const keyCount = typeof row?.key_count === 'number' ? row.key_count : 0;
  if (origin !== 'none') console.info(`${LOG} document attributes applied`, { documentId, origin, keys: keyCount });
  return { origin, keyCount };
}

/**
 * Stage hook: the version's document row exists and no chunk is written yet. Feature off: nothing is called, and an input that still
 * carries attributes (the switch changed after the route checked) fails the run with attributes_not_enabled. Feature on: the apply runs
 * once for every begun version, also without explicit values (staged and inherited values).
 */
export async function applyDocumentAttributes(ctx: StageContext): Promise<void> {
  if (!ctx.document || !ctx.identity) return;
  if (!docAttributesEnabled(ctx.config)) {
    if (ctx.input.attributes !== undefined) throw new IngestStageError('file_hash_dedup', 'attributes_not_enabled');
    return;
  }
  const db = ctx.deps.db();
  if (!db) throw new IngestStageError('file_hash_dedup', 'db_unavailable');
  await writeDocumentAttributes(db, ctx.identity.tenantKey, ctx.document.id, ctx.input.attributes, ctx.signal);
}

export interface AttributeRowInput {
  source: string;
  sourceKey: string;
  attributes: IngestAttributeValues;
}

export type AttributeCallFailure = { ok: false; reason: string };

function rowsPayload(rows: readonly AttributeRowInput[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({ source: row.source, source_key: row.sourceKey, attributes: row.attributes }));
}

async function call(db: RpcClient, fn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: true; rows: Array<Record<string, unknown>> } | AttributeCallFailure> {
  try {
    signal.throwIfAborted();
    const response = await db.rpc(fn, args).abortSignal(signal);
    if (response.error) {
      const reason = reasonOf(response.error, 'unavailable');
      console.error(`${LOG} attribute call failed`, { rpc: fn, reason, code: response.error.code ?? null });
      return { ok: false, reason };
    }
    return { ok: true, rows: rpcRows(response.data) as Array<Record<string, unknown>> };
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`${LOG} attribute call failed`, { rpc: fn, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  }
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Stages values by (source, source key) for documents that do not exist yet, in batches of 500 (rag_stage_document_attributes). */
export async function stageAttributeRows(
  db: RpcClient,
  tenantKey: string,
  rows: readonly AttributeRowInput[],
  signal: AbortSignal,
): Promise<{ ok: true; staged: number; unchanged: number } | AttributeCallFailure> {
  let staged = 0;
  let unchanged = 0;
  for (let start = 0; start < rows.length; start += STAGE_BATCH) {
    const result = await call(db, 'rag_stage_document_attributes', { p_tenant_key: tenantKey, p_rows: rowsPayload(rows.slice(start, start + STAGE_BATCH)) }, signal);
    if (!result.ok) return result;
    staged += count(result.rows[0]?.staged);
    unchanged += count(result.rows[0]?.unchanged);
  }
  return { ok: true, staged, unchanged };
}

export async function readStagedAttributes(
  db: RpcClient,
  tenantKey: string,
  source: string,
  sourceKeys: readonly string[],
  signal: AbortSignal,
): Promise<{ ok: true; rows: Array<{ sourceKey: string; attributes: IngestAttributeValues; stagedAt: string }> } | AttributeCallFailure> {
  const result = await call(db, 'rag_staged_attributes_read', { p_tenant_key: tenantKey, p_source: source, p_source_keys: [...sourceKeys] }, signal);
  if (!result.ok) return result;
  return {
    ok: true,
    rows: result.rows.map((row) => ({
      sourceKey: String(row.source_key),
      attributes: (row.attributes ?? {}) as IngestAttributeValues,
      stagedAt: String(row.staged_at),
    })),
  };
}

export interface ImportAttributeRowsResult {
  ok: true;
  documentsChanged: number;
  documentsUnchanged: number;
  chunksUpdated: number;
  staged: number;
  stagedUnchanged: number;
  changedDocumentIds: string[];
  outboxRows: number;
}

/** Import by source key (rag_import_document_attributes): at most 500 rows per call; a dry run writes nothing and returns the same counts. */
export async function importAttributeRows(
  db: RpcClient,
  tenantKey: string,
  rows: readonly AttributeRowInput[],
  options: { dryRun: boolean; signal: AbortSignal; config?: IngestConfig },
): Promise<ImportAttributeRowsResult | AttributeCallFailure> {
  const result = await call(
    db,
    'rag_import_document_attributes',
    { p_tenant_key: tenantKey, p_rows: rowsPayload(rows), p_dry_run: options.dryRun },
    options.signal,
  );
  if (!result.ok) return result;
  const row = result.rows[0] ?? {};
  return {
    ok: true,
    documentsChanged: count(row.documents_changed),
    documentsUnchanged: count(row.documents_unchanged),
    chunksUpdated: count(row.chunks_updated),
    staged: count(row.staged),
    stagedUnchanged: count(row.staged_unchanged),
    changedDocumentIds: Array.isArray(row.changed_document_ids) ? row.changed_document_ids.map(String) : [],
    outboxRows: count(row.outbox_rows),
  };
}

export async function readDocumentAttributes(
  db: RpcClient,
  tenantKey: string,
  documentIds: readonly string[],
  signal: AbortSignal,
): Promise<{ ok: true; rows: Array<{ documentId: string; attributes: IngestAttributeValues | null }> } | AttributeCallFailure> {
  const result = await call(db, 'rag_document_attributes_read', { p_tenant_key: tenantKey, p_document_ids: [...documentIds] }, signal);
  if (!result.ok) return result;
  return {
    ok: true,
    rows: result.rows.map((row) => ({ documentId: String(row.document_id), attributes: (row.attributes ?? null) as IngestAttributeValues | null })),
  };
}

export interface UploadAttributesRefusal {
  status: 400 | 503;
  body: Record<string, unknown>;
}

/** The wire answer of a refused check: 400 attributes_not_enabled, 400 invalid_attributes with one detail per error, 503 unavailable. */
export function uploadAttributesRefusal(result: Exclude<ValidateUploadAttributesResult, { ok: true }>): UploadAttributesRefusal {
  if (result.reason === 'unavailable') return { status: 503, body: { error: 'attributes_unavailable' } };
  if (result.reason === 'attributes_not_enabled') return { status: 400, body: { success: false, error: 'attributes_not_enabled' } };
  return {
    status: 400,
    body: {
      success: false,
      error: 'invalid_attributes',
      details: result.errors.map((error) => ({ path: error.key === '' ? 'attributes' : `attributes.${error.key}`, message: error.code })),
    },
  };
}

/** The form field as the check takes it: absent is null, a string as sent, anything else (a file part) a malformed value. */
export function attributesFormField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : '';
}

/** Not implemented yet (plan 03.3-15 RED). */
export async function renderDocumentHeaders(_db: RpcClient, _tenantKey: string, _documentIds: readonly string[], _signal: AbortSignal): Promise<{ ok: true; rendered: number }> {
  return { ok: true, rendered: 0 };
}

/** Not implemented yet (plan 03.3-15 RED). */
export async function renderPendingHeaders(_db: RpcClient, _tenantKey: string, _options: { signal: AbortSignal; deadlineMs: number }): Promise<{ ok: true; rendered: number; more: boolean }> {
  return { ok: true, rendered: 0, more: false };
}
