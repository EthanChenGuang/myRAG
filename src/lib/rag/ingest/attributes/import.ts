import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { AttributeImportRowSchema } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../../backend/supabase-rpc';
import type { TenantIdentifierPatterns } from '../../identifiers/patterns';
import { scopeKey, type TenantScope } from '../../tenant/scope';
import { BACKFILL_SOURCE } from '../backfill/run';
import type { RunnerIo } from '../backfill/runners';
import type { IngestAttributeValues } from '../types';
import { importAttributeRows, type AttributeRowInput, type ImportAttributeRowsResult } from './apply';
import { reindexAttributeIdentifiers, reindexCommand, reindexReportLines, type ReindexAttributeIdentifiersReport } from './identifier-feed';
import { loadAttributeSchema, type LoadAttributeSchemaResult } from './schema';
import { ATTRIBUTE_KEY_PATTERN, validateAttributes, type AttributeErrorCode } from './validate';

/**
 * The rag:attributes import (TPL-04, D-12, D-24): reads a JSON Lines file of { source_key, attributes, source? }, validates every row
 * against the tenant's schema (all or nothing), reports what a run would change through the dry-run form of
 * rag_import_document_attributes and, with --apply, writes in batches. Output carries counts, line numbers, code words and attribute keys,
 * never a value; a key that does not match the key pattern is not printed either.
 */

export const IMPORT_MAX_ROWS = 50_000;
export const IMPORT_BATCH_ROWS = 200;
export const IMPORT_MAX_PRINTED_ERRORS = 50;

const LOG = '[RAG Attributes]';

export type ImportLineCode = 'invalid_json' | 'invalid_row' | 'duplicate_key' | 'too_many_rows';

export interface ImportLineError {
  line: number;
  code: ImportLineCode | AttributeErrorCode;
  key?: string;
}

export interface ImportFileRow {
  line: number;
  source: string;
  sourceKey: string;
  attributes: Record<string, unknown>;
}

export interface ImportFileRead {
  rows: ImportFileRow[];
  errors: ImportLineError[];
}

/** The file could not be opened or read: a usage error (exit 64). */
export class ImportFileError extends Error {
  constructor() {
    super('the import file could not be read');
    this.name = 'ImportFileError';
  }
}

const printableKey = (key: unknown): string | undefined => (typeof key === 'string' && ATTRIBUTE_KEY_PATTERN.test(key) ? key : undefined);

function rowError(line: number, issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): ImportLineError {
  const first = issues[0];
  const key = first && first.path[0] === 'attributes' ? printableKey(first.path[1]) : undefined;
  return key === undefined ? { line, code: 'invalid_row' } : { line, code: 'invalid_row', key };
}

/** Streams the file line by line. Blank lines are skipped; reading stops at row IMPORT_MAX_ROWS + 1 with too_many_rows. */
export async function readImportFile(filePath: string, options: { signal: AbortSignal }): Promise<ImportFileRead> {
  const rows: ImportFileRow[] = [];
  const errors: ImportLineError[] = [];
  const seen = new Set<string>();
  let counted = 0;
  let lineNumber = 0;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      lineNumber += 1;
      if (lineNumber % 1000 === 0) options.signal.throwIfAborted();
      if (raw.trim() === '') continue;
      counted += 1;
      if (counted > IMPORT_MAX_ROWS) {
        errors.push({ line: lineNumber, code: 'too_many_rows' });
        break;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        errors.push({ line: lineNumber, code: 'invalid_json' });
        continue;
      }
      const parsed = AttributeImportRowSchema.safeParse(value);
      if (!parsed.success) {
        errors.push(rowError(lineNumber, parsed.error.issues));
        continue;
      }
      const source = parsed.data.source ?? BACKFILL_SOURCE;
      const identity = `${source}\u0000${parsed.data.source_key}`;
      if (seen.has(identity)) {
        errors.push({ line: lineNumber, code: 'duplicate_key' });
        continue;
      }
      seen.add(identity);
      rows.push({ line: lineNumber, source, sourceKey: parsed.data.source_key, attributes: parsed.data.attributes });
    }
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new ImportFileError();
  } finally {
    lines.close();
    stream.destroy();
  }
  options.signal.throwIfAborted();
  return { rows, errors };
}

export interface ImportTotals {
  documentsChanged: number;
  documentsUnchanged: number;
  chunksUpdated: number;
  staged: number;
  stagedUnchanged: number;
  outboxRows: number;
}

const emptyTotals = (): ImportTotals => ({ documentsChanged: 0, documentsUnchanged: 0, chunksUpdated: 0, staged: 0, stagedUnchanged: 0, outboxRows: 0 });

function addTotals(totals: ImportTotals, result: ImportAttributeRowsResult): void {
  totals.documentsChanged += result.documentsChanged;
  totals.documentsUnchanged += result.documentsUnchanged;
  totals.chunksUpdated += result.chunksUpdated;
  totals.staged += result.staged;
  totals.stagedUnchanged += result.stagedUnchanged;
  totals.outboxRows += result.outboxRows;
}

/** The refusal lines of a file with errors: totals per code, then the first IMPORT_MAX_PRINTED_ERRORS errors. Pure. */
export function errorReportLines(rowsRead: number, errors: readonly ImportLineError[]): string[] {
  const perCode = new Map<string, number>();
  for (const error of errors) perCode.set(error.code, (perCode.get(error.code) ?? 0) + 1);
  const lines = [`${LOG} rows read: ${rowsRead}`, `${LOG} errors: ${errors.length}`];
  for (const code of [...perCode.keys()].sort()) lines.push(`${LOG}   ${code}: ${perCode.get(code)}`);
  for (const error of errors.slice(0, IMPORT_MAX_PRINTED_ERRORS)) lines.push(`${LOG}   line ${error.line}: ${error.code}${error.key ? ` ${error.key}` : ''}`);
  if (errors.length > IMPORT_MAX_PRINTED_ERRORS) lines.push(`${LOG}   ... ${errors.length - IMPORT_MAX_PRINTED_ERRORS} more`);
  lines.push(`${LOG} file refused: nothing was written`);
  return lines;
}

/** The dry-run report lines. Pure. */
export function dryRunReportLines(rowsRead: number, totals: ImportTotals): string[] {
  return [
    `${LOG} rows read: ${rowsRead}`,
    `${LOG} documents to change: ${totals.documentsChanged}`,
    `${LOG} documents unchanged: ${totals.documentsUnchanged}`,
    `${LOG} rows to stage: ${totals.staged}`,
    `${LOG} staged rows unchanged: ${totals.stagedUnchanged}`,
    `${LOG} chunk rows to update: ${totals.chunksUpdated}`,
  ];
}

export interface AttributesImportInput {
  scope: TenantScope;
  file: string;
  apply: boolean;
}

export interface AttributesImportDeps {
  /** Defaults to the ingest deps' database client. */
  rpc?: RpcClient | null;
  signal: AbortSignal;
  io: RunnerIo;
  /** Defaults to loadAttributeSchema with the fresh option. */
  loadSchema?: (scope: TenantScope, signal: AbortSignal) => Promise<LoadAttributeSchemaResult>;
  /** RAG_IDENTIFIER_INDEX for the re-index after the apply pass; defaults to the typed RAG configuration. */
  identifierIndex?: () => boolean | Promise<boolean>;
  /** Test seam passed to the indexer. */
  loadPatterns?: (scope: TenantScope, options: { signal: AbortSignal }) => Promise<TenantIdentifierPatterns>;
}

export type AttributesImportStatus = 'done' | 'failed' | 'report_only' | 'refused';

export interface AttributesImportOutcome {
  exitCode: 0 | 1 | 2 | 3;
  status: AttributesImportStatus;
  rowsRead: number;
  errors: ImportLineError[];
  dryRun: ImportTotals | null;
  applied: ImportTotals | null;
  batches: number;
  batchesApplied: number;
  /** Ids of the documents the apply pass changed (ids only), for the identifier re-index of plan 03.3-16. */
  changedDocumentIds: string[];
  /** The identifier re-index after the apply pass (plan 03.3-16); null when it did not run (no flagged definition, or no apply). */
  reindex: ReindexAttributeIdentifiersReport | null;
}

function batchesOf(rows: readonly AttributeRowInput[]): AttributeRowInput[][] {
  const batches: AttributeRowInput[][] = [];
  for (let start = 0; start < rows.length; start += IMPORT_BATCH_ROWS) batches.push(rows.slice(start, start + IMPORT_BATCH_ROWS));
  return batches;
}

/**
 * Reads and validates the file, runs the dry-run pass over every batch and, with apply, the write pass. Throws ImportFileError for an
 * unreadable file and rethrows when the signal aborts; every other failure is an outcome with its exit code.
 */
export async function runAttributesImport(input: AttributesImportInput, deps: AttributesImportDeps): Promise<AttributesImportOutcome> {
  const { io, signal } = deps;
  const tenantKey = scopeKey(input.scope);
  const read = await readImportFile(input.file, { signal });
  const rowsRead = read.rows.length + read.errors.filter((error) => error.code !== 'too_many_rows').length;
  const base = { rowsRead, dryRun: null, applied: null, batches: 0, batchesApplied: 0, changedDocumentIds: [] as string[], reindex: null };

  const schema = await (deps.loadSchema ?? ((scope, s) => loadAttributeSchema(scope, { signal: s, fresh: true })))(input.scope, signal);
  signal.throwIfAborted();
  if (!schema.ok) {
    io.err(`${LOG} the attribute schema could not be read`);
    return { ...base, exitCode: 1, status: 'failed', errors: read.errors };
  }

  const errors: ImportLineError[] = [...read.errors];
  const rows: AttributeRowInput[] = [];
  for (const item of read.rows) {
    const checked = validateAttributes(schema.definitions, item.attributes);
    if (!checked.ok) {
      for (const error of checked.errors) {
        const key = printableKey(error.key);
        errors.push(key === undefined ? { line: item.line, code: error.code } : { line: item.line, code: error.code, key });
      }
      continue;
    }
    rows.push({ source: item.source, sourceKey: item.sourceKey, attributes: checked.values as IngestAttributeValues });
  }
  if (errors.length > 0) {
    errors.sort((a, b) => a.line - b.line);
    for (const line of errorReportLines(rowsRead, errors)) io.out(line);
    return { ...base, exitCode: 3, status: 'refused', errors };
  }

  const db = deps.rpc === undefined ? (await import('../deps')).getIngestDeps().db() : deps.rpc;
  if (!db) {
    io.err(`${LOG} the database is not configured: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return { ...base, exitCode: 1, status: 'failed', errors };
  }

  const batches = batchesOf(rows);
  const dryRun = emptyTotals();
  for (const [index, batch] of batches.entries()) {
    const result = await importAttributeRows(db, tenantKey, batch, { dryRun: true, signal });
    if (!result.ok) {
      io.err(`${LOG} dry run failed at batch ${index + 1} of ${batches.length}: ${result.reason}; nothing was written`);
      return { ...base, exitCode: 1, status: 'failed', errors, batches: batches.length, dryRun };
    }
    addTotals(dryRun, result);
  }
  for (const line of dryRunReportLines(rowsRead, dryRun)) io.out(line);

  if (!input.apply) {
    io.out(`${LOG} report only: nothing was written; run again with --apply to write`);
    return { ...base, exitCode: 2, status: 'report_only', errors, batches: batches.length, dryRun };
  }

  const applied = emptyTotals();
  const changed = new Set<string>();
  for (const [index, batch] of batches.entries()) {
    const result = await importAttributeRows(db, tenantKey, batch, { dryRun: false, signal });
    if (!result.ok) {
      io.err(`${LOG} failed at batch ${index + 1} of ${batches.length}: ${result.reason}; ${index} of ${batches.length} batches applied`);
      io.err(`${LOG} applied batches stay applied; running the same file again completes the import`);
      return { ...base, exitCode: 1, status: 'failed', errors, batches: batches.length, batchesApplied: index, dryRun, applied, changedDocumentIds: [...changed] };
    }
    addTotals(applied, result);
    for (const id of result.changedDocumentIds) changed.add(id);
    io.out(
      `${LOG} batch ${index + 1} of ${batches.length}: documents changed ${result.documentsChanged}, unchanged ${result.documentsUnchanged}, ` +
        `rows staged ${result.staged}, chunk rows updated ${result.chunksUpdated}`,
    );
  }
  io.out(`${LOG} documents changed: ${applied.documentsChanged}`);
  io.out(`${LOG} documents unchanged: ${applied.documentsUnchanged}`);
  io.out(`${LOG} rows staged: ${applied.staged}`);
  io.out(`${LOG} staged rows unchanged: ${applied.stagedUnchanged}`);
  io.out(`${LOG} chunk rows updated: ${applied.chunksUpdated} in ${batches.length} batches`);
  io.out(`${LOG} vector sync outbox rows added: ${applied.outboxRows}`);

  // TPL-04 (D-25): the changed documents get their attribute identifiers through the 4.2 indexer in the same run.
  let reindex: ReindexAttributeIdentifiersReport | null = null;
  if (schema.definitions.some((definition) => definition.in_identifier_index)) {
    reindex = await reindexAttributeIdentifiers(input.scope, [...changed], {
      db,
      signal,
      ...(deps.identifierIndex ? { identifierIndex: deps.identifierIndex } : {}),
      ...(deps.loadPatterns ? { loadPatterns: deps.loadPatterns } : {}),
    });
    const lines = await reindexReportLines(reindex, reindexCommand(tenantKey));
    for (const line of lines.out) io.out(line);
    for (const line of lines.err) io.err(line);
    if (reindex.failed > 0) {
      return { ...base, exitCode: 1, status: 'failed', errors, batches: batches.length, batchesApplied: batches.length, dryRun, applied, changedDocumentIds: [...changed], reindex };
    }
  }
  return { ...base, reindex, exitCode: 0, status: 'done', errors, batches: batches.length, batchesApplied: batches.length, dryRun, applied, changedDocumentIds: [...changed] };
}
