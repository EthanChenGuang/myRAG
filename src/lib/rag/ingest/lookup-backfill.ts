import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantIdentifierPatterns } from '../identifiers/patterns';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { indexDocumentForLookup, type IndexDocumentReport } from './write-indexers';
import { createIngestWriter, isTenantKey } from './writer';

/** Which lookup index a backfill writes: rag_table_rows (RET-12) or the identifier columns (RET-15). */
export type LookupBackfillKind = 'tables' | 'identifiers';

export const DEFAULT_LOOKUP_BACKFILL_BATCH_SIZE = 100;
export const MAX_LOOKUP_BACKFILL_BATCH_SIZE = 1000;
/** The shell convention for a run stopped by SIGINT. */
export const EXIT_INTERRUPTED = 130;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTING_RPC = 'rag_index_backfill_documents';
const WITH_VALUE = new Set(['--batch-size', '--tenant', '--resume-after']);

/** Bad input or a failed listing call; carries a code and the RPC error code only, never a database message. */
export class LookupBackfillError extends Error {
  readonly code: string;
  readonly rpcCode: string | null;

  constructor(code: string, rpcCode: string | null = null) {
    super(`[RAG Lookup Backfill] ${code}${rpcCode ? ` (${rpcCode})` : ''}`);
    this.name = 'LookupBackfillError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

export type ParsedLookupBackfillArgs =
  | { ok: true; dryRun: boolean; tenantKey: string | null; batchSize: number; resumeAfter: string | null }
  | { ok: false; error: string };

/** `[--tenant <key>] [--dry-run] [--batch-size n] [--resume-after <documentId>]`; no tenant means every tenant. */
export function parseLookupBackfillArgs(argv: string[]): ParsedLookupBackfillArgs {
  let dryRun = false;
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') {
      if (dryRun) return { ok: false, error: '--dry-run was given twice' };
      dryRun = true;
    } else if (WITH_VALUE.has(arg)) {
      const value = argv[(i += 1)];
      if (value === undefined || value.startsWith('--')) return { ok: false, error: `${arg} needs a value` };
      if (values.has(arg)) return { ok: false, error: `${arg} was given twice` };
      values.set(arg, value);
    } else {
      return { ok: false, error: `unknown option: ${arg}` };
    }
  }

  const rawTenant = values.get('--tenant');
  const tenantKey = rawTenant === undefined ? null : rawTenant.trim().toLowerCase();
  if (tenantKey !== null && !isTenantKey(tenantKey)) return { ok: false, error: '--tenant needs a tenant key: s:default, u:<uuid> or o:<uuid>' };

  let batchSize = DEFAULT_LOOKUP_BACKFILL_BATCH_SIZE;
  const rawBatch = values.get('--batch-size');
  if (rawBatch !== undefined) {
    const parsed = /^\d+$/.test(rawBatch) ? Number(rawBatch) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LOOKUP_BACKFILL_BATCH_SIZE) {
      return { ok: false, error: `--batch-size needs an integer from 1 to ${MAX_LOOKUP_BACKFILL_BATCH_SIZE}` };
    }
    batchSize = parsed;
  }

  const resumeAfter = values.get('--resume-after')?.toLowerCase() ?? null;
  if (resumeAfter !== null && !UUID.test(resumeAfter)) return { ok: false, error: '--resume-after needs a document id (a UUID)' };
  if (resumeAfter !== null && tenantKey === null) return { ok: false, error: '--resume-after needs --tenant: the cursor belongs to one tenant' };

  return { ok: true, dryRun, tenantKey, batchSize, resumeAfter };
}

export interface LookupBackfillBatchInfo {
  tenantKey: string;
  /** 1-based batch index within this tenant's run. */
  batch: number;
  documents: number;
  failed: number;
  /** Last document id of the batch (the keyset cursor for --resume-after). */
  cursor: string;
}

export interface LookupBackfillInput {
  db: RpcClient;
  /** A verified scope (backfillScope); the listing and every write are bound to its tenant key. */
  scope: TenantScope;
  batchSize?: number;
  resumeAfter?: string | null;
  signal?: AbortSignal;
  onBatch?: (info: LookupBackfillBatchInfo) => void | Promise<void>;
  /** Test seam for the identifier patterns; defaults to loadTenantIdentifierPatterns. */
  loadPatterns?: (scope: TenantScope, options: { signal: AbortSignal }) => Promise<TenantIdentifierPatterns>;
}

export interface LookupBackfillReport {
  tenantKey: string;
  /** Documents indexed without a warning. */
  documents: number;
  /** Documents whose indexing logged a warning; a later run picks them up again. */
  failed: number;
  batches: number;
  /** Table rows (tables kind). */
  rowsWritten: number;
  rowsDeleted: number;
  /** Chunks read back and given identifiers, chunks whose stored identifiers changed, documents whose union changed (identifiers kind). */
  chunksIndexed: number;
  chunksWritten: number;
  documentsChanged: number;
}

export interface LookupBackfillDryRunReport {
  tenantKey: string;
  documents: number;
  current: number;
  superseded: number;
}

interface ListedDocument {
  documentId: string;
  isCurrent: boolean;
}

function checkBatchSize(batchSize: number | undefined): number {
  const size = batchSize ?? DEFAULT_LOOKUP_BACKFILL_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_LOOKUP_BACKFILL_BATCH_SIZE) throw new LookupBackfillError('invalid_batch_size');
  return size;
}

function checkCursor(value: string | null | undefined): string | null {
  const cursor = value ?? null;
  if (cursor !== null && !UUID.test(cursor)) throw new LookupBackfillError('invalid_resume_after');
  return cursor;
}

async function listDocuments(
  db: RpcClient,
  tenantKey: string,
  kind: LookupBackfillKind,
  after: string | null,
  limit: number,
  signal: AbortSignal,
): Promise<ListedDocument[]> {
  signal.throwIfAborted();
  const response = await db.rpc(LISTING_RPC, { p_tenant_key: tenantKey, p_kind: kind, p_after: after, p_limit: limit }).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new LookupBackfillError(`rpc_failed:${LISTING_RPC}`, response.error.code ?? null);
  const listed: ListedDocument[] = [];
  for (const row of (response.data ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.document_id !== 'string') throw new LookupBackfillError(`bad_response:${LISTING_RPC}`);
    listed.push({ documentId: row.document_id, isCurrent: row.is_current === true });
  }
  return listed;
}

/** D-15, D-28: counts the documents a run would index (ready, non-provisional, current or superseded); writes nothing. */
export async function dryRunLookupBackfill(
  kind: LookupBackfillKind,
  input: Omit<LookupBackfillInput, 'onBatch' | 'loadPatterns'>,
): Promise<LookupBackfillDryRunReport> {
  const batchSize = checkBatchSize(input.batchSize);
  const signal = input.signal ?? new AbortController().signal;
  const tenantKey = scopeKey(input.scope).toLowerCase();
  const report: LookupBackfillDryRunReport = { tenantKey, documents: 0, current: 0, superseded: 0 };
  let after = checkCursor(input.resumeAfter);
  for (;;) {
    const page = await listDocuments(input.db, tenantKey, kind, after, batchSize, signal);
    for (const listed of page) {
      report.documents += 1;
      if (listed.isCurrent) report.current += 1;
      else report.superseded += 1;
    }
    if (page.length < batchSize) return report;
    after = page[page.length - 1]?.documentId ?? after;
  }
}

function addDocument(report: LookupBackfillReport, result: IndexDocumentReport): boolean {
  if (result.tables) {
    report.rowsWritten += result.tables.rowsWritten;
    report.rowsDeleted += result.tables.rowsDeleted;
  }
  if (result.identifiers) {
    report.chunksIndexed += result.identifiers.chunksIndexed;
    report.chunksWritten += result.identifiers.chunksWritten;
    if (result.identifiers.documentChanged) report.documentsChanged += 1;
  }
  // identifier_patterns_unavailable still indexes with the built-in rule; only a failed part counts the document as failed.
  return result.warnings.some((warning) => warning === 'index_tables_failed' || warning === 'index_identifiers_failed');
}

/**
 * D-15, D-28: indexes the tenant's listed documents through indexDocumentForLookup (the write-stage routine of plan 04.2-18) in keyset
 * batches of document ids. The tables kind rewrites every profile's rows of each document (the same rows again on a second run); the
 * identifiers kind lists only documents with an unindexed chunk, so a second run finds nothing to do. Throws when aborted between or
 * inside a document; counts only, never a cell value, header or identifier.
 */
export async function runLookupBackfill(kind: LookupBackfillKind, input: LookupBackfillInput): Promise<LookupBackfillReport> {
  const batchSize = checkBatchSize(input.batchSize);
  const signal = input.signal ?? new AbortController().signal;
  const tenantKey = scopeKey(input.scope).toLowerCase();
  const writer = createIngestWriter({ db: input.db, scope: input.scope, signal });
  const report: LookupBackfillReport = {
    tenantKey,
    documents: 0,
    failed: 0,
    batches: 0,
    rowsWritten: 0,
    rowsDeleted: 0,
    chunksIndexed: 0,
    chunksWritten: 0,
    documentsChanged: 0,
  };
  let after = checkCursor(input.resumeAfter);
  for (;;) {
    signal.throwIfAborted();
    const page = await listDocuments(input.db, tenantKey, kind, after, batchSize, signal);
    if (page.length === 0) break;
    let documents = 0;
    let failed = 0;
    for (const listed of page) {
      const result = await indexDocumentForLookup({
        writer,
        scope: input.scope,
        documentId: listed.documentId,
        tables: kind === 'tables',
        identifiers: kind === 'identifiers',
        signal,
        ...(input.loadPatterns ? { loadPatterns: input.loadPatterns } : {}),
      });
      if (addDocument(report, result)) failed += 1;
      else documents += 1;
    }
    report.batches += 1;
    report.documents += documents;
    report.failed += failed;
    const cursor = page[page.length - 1]?.documentId as string;
    await input.onBatch?.({ tenantKey, batch: report.batches, documents, failed, cursor });
    after = cursor;
    if (page.length < batchSize) break;
  }
  return report;
}

export interface TenantListingAdmin {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        gt(column: string, value: string): {
          order(column: string, options: { ascending: boolean }): {
            limit(count: number): { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { code?: string } | null }> };
          };
        };
      };
    };
  };
}

/**
 * The tenants a run without --tenant covers: s:default in single-tenant mode; in multi-tenant mode every tenant key that has a ready
 * document, read one distinct key at a time in key order through the service-role client.
 */
export async function listBackfillTenants(input: { multiTenant: boolean; admin: TenantListingAdmin | null; signal: AbortSignal }): Promise<string[]> {
  if (!input.multiTenant) return ['s:default'];
  if (!input.admin) throw new LookupBackfillError('admin_unavailable');
  const keys: string[] = [];
  let last = '';
  for (;;) {
    input.signal.throwIfAborted();
    const response = await input.admin
      .from('documents')
      .select('tenant_key')
      .eq('status', 'ready')
      .gt('tenant_key', last)
      .order('tenant_key', { ascending: true })
      .limit(1)
      .abortSignal(input.signal);
    if (response.error) throw new LookupBackfillError('tenant_listing_failed', response.error.code ?? null);
    const row = Array.isArray(response.data) ? (response.data[0] as { tenant_key?: unknown } | undefined) : undefined;
    const key = typeof row?.tenant_key === 'string' ? row.tenant_key.toLowerCase() : null;
    if (key === null) return keys;
    if (key <= last) throw new LookupBackfillError('tenant_listing_failed');
    if (isTenantKey(key) && !key.startsWith('s:')) keys.push(key);
    last = key;
  }
}
