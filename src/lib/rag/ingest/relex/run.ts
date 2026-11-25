import type { RpcClient } from '../../backend/supabase-rpc';
import { detectLanguage } from '../../lang/detect';
import { getLanguageSettings } from '../../lang/settings';
import { LEXICAL_VERSION, chunkLexicalText } from '../../lexical/chunk-text';
import { tableRowLanguage, tableRowSeparator } from '../text/table-rows';
import { isTenantKey } from '../writer';

/** Bad arguments or limits; nothing was written. */
export class RelexInputError extends Error {
  readonly code: string;
  /** The failing RPC's error code (SQLSTATE or PostgREST code), when there is one. */
  readonly rpcCode: string | null;

  constructor(code: string, rpcCode: string | null = null) {
    super(`[RAG Relex] ${code}${rpcCode ? ` (${rpcCode})` : ''}`);
    this.name = 'RelexInputError';
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

export interface RelexBatchInfo {
  /** 1-based batch index within this call. */
  batch: number;
  /** Rows the batch RPC reported as updated. */
  updated: number;
  /** Last chunk id processed in this batch (the keyset cursor). */
  cursor: string;
}

export interface RunRelexInput {
  db: RpcClient;
  batchSize?: number;
  tenantKey?: string | null;
  resumeAfter?: string | null;
  onBatch?: (info: RelexBatchInfo) => void | Promise<void>;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /**
   * RAG_TABLE_ROW_SERIALIZATION as the run applies it (D-21). Given, the stale pass serializes table rows when true and a table pass
   * afterwards rewrites every current table chunk whose stored lexical_text does not match it. Absent, the run is the version-only relex.
   */
  tableRowSerialization?: boolean;
}

export interface RelexReport {
  updated: number;
  batches: number;
  tenants: Record<string, number>;
  /** Table chunks the table pass rewrote; present only when the run was given tableRowSerialization. */
  tables?: number;
}

export interface DryRunRelexInput {
  db: RpcClient;
  tenantKey?: string | null;
  batchSize?: number;
  resumeAfter?: string | null;
  signal?: AbortSignal;
  tableRowSerialization?: boolean;
}

export interface DryRunRelexReport {
  tenants: Record<string, number>;
  total: number;
  /** Table chunks a run would rewrite in its table pass; present only when given tableRowSerialization. */
  tables?: number;
}

export const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;

type Row = Record<string, unknown>;

interface RelexCandidate {
  id: string;
  tenant_key: string;
  content: string;
  section_path: string[];
  chunk_kind: string | null;
  metadata: Record<string, unknown> | null;
  language: string | null;
  document_filename: string;
}

interface TableCandidate extends RelexCandidate {
  document_language: string | null;
  lexical_text: string | null;
}

type BatchRow = { id: string; lexical_text: string; language?: string };

const MISSING_FUNCTION_CODES: ReadonlySet<string> = new Set(['PGRST202', '42883']);
const TABLE_CANDIDATES_RPC = 'rag_relex_table_candidates';

function checkBatchSize(batchSize: number | undefined): number {
  const size = batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new RelexInputError('invalid_batch_size');
  return size;
}

function checkTenantKey(tenantKey: string | null | undefined): string | null {
  const key = tenantKey ?? null;
  if (key !== null && !isTenantKey(key)) throw new RelexInputError('invalid_tenant_key');
  return key;
}

async function callRpc(db: RpcClient, signal: AbortSignal, rpc: string, args: Record<string, unknown>): Promise<Row[]> {
  signal.throwIfAborted();
  const response = await db.rpc(rpc, args).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RelexInputError(`rpc_failed:${rpc}`, response.error.code ?? null);
  return (response.data ?? []) as Row[];
}

function asCandidate(row: Row): RelexCandidate {
  const sectionPath = row.section_path;
  const metadata = row.metadata;
  return {
    id: String(row.id),
    tenant_key: String(row.tenant_key),
    content: typeof row.content === 'string' ? row.content : '',
    section_path: Array.isArray(sectionPath) ? sectionPath.map((entry) => String(entry)) : [],
    chunk_kind: typeof row.chunk_kind === 'string' ? row.chunk_kind : null,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null,
    language: typeof row.language === 'string' ? row.language : null,
    document_filename: typeof row.document_filename === 'string' ? row.document_filename : '',
  };
}

/** The serialization the run applies; null means plain text (the switch off, or a run not given the switch). */
interface RowSerialization {
  enabled: boolean;
  primary: string | null;
}

function lexicalTextOf(candidate: RelexCandidate, rows: RowSerialization | null, documentLanguage: string | null = null): string {
  const separator = rows
    ? tableRowSeparator(rows.enabled, candidate.chunk_kind, tableRowLanguage({ chunkLanguage: candidate.language, documentLanguage, primary: rows.primary }))
    : null;
  return chunkLexicalText({
    sectionPath: candidate.section_path,
    content: candidate.content,
    chunkKind: candidate.chunk_kind,
    metadata: candidate.metadata,
    documentFilename: candidate.document_filename,
    ...(separator !== null ? { tableRowSeparator: separator } : {}),
  });
}

function batchRow(candidate: RelexCandidate, rows: RowSerialization | null): BatchRow {
  const lexical_text = lexicalTextOf(candidate, rows);
  const row: BatchRow = { id: candidate.id, lexical_text };
  if (candidate.language === null) {
    const detected = detectLanguage(candidate.content);
    if (detected !== null) row.language = detected;
  }
  return row;
}

async function listCandidates(
  db: RpcClient,
  signal: AbortSignal,
  after: string | null,
  limit: number,
  tenantKey: string | null,
): Promise<RelexCandidate[]> {
  const rows = await callRpc(db, signal, 'rag_relex_candidates', {
    p_after: after,
    p_version: LEXICAL_VERSION,
    p_limit: limit,
    p_tenant_key: tenantKey,
  });
  return rows.map(asCandidate);
}

function asTableCandidate(row: Row): TableCandidate {
  return {
    ...asCandidate(row),
    document_language: typeof row.document_language === 'string' ? row.document_language : null,
    lexical_text: typeof row.lexical_text === 'string' ? row.lexical_text : null,
  };
}

/** A page of current table chunks with their stored text; null when the database predates the function (migration 0815). */
async function listTableCandidates(
  db: RpcClient,
  signal: AbortSignal,
  after: string | null,
  limit: number,
  tenantKey: string | null,
): Promise<TableCandidate[] | null> {
  signal.throwIfAborted();
  const response = await db.rpc(TABLE_CANDIDATES_RPC, { p_after: after, p_limit: limit, p_tenant_key: tenantKey }).abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) {
    if (response.error.code && MISSING_FUNCTION_CODES.has(response.error.code)) return null;
    throw new RelexInputError(`rpc_failed:${TABLE_CANDIDATES_RPC}`, response.error.code ?? null);
  }
  return ((response.data ?? []) as Row[]).map(asTableCandidate);
}

/** The table chunks of one page whose stored lexical_text differs from the text the switch state gives, with that text. */
function staleTableRows(candidates: TableCandidate[], rows: RowSerialization): BatchRow[] {
  const out: BatchRow[] = [];
  for (const candidate of candidates) {
    const lexical_text = lexicalTextOf(candidate, rows, candidate.document_language);
    if (lexical_text !== candidate.lexical_text) out.push({ id: candidate.id, lexical_text });
  }
  return out;
}

function rowSerializationOf(enabled: boolean | undefined): RowSerialization | null {
  if (enabled === undefined) return null;
  return { enabled, primary: enabled ? getLanguageSettings().primary : null };
}

/**
 * D-21 and research Pitfall 12: RAG_TABLE_ROW_SERIALIZATION changes the lexical_text of table chunks without a new LEXICAL_VERSION (it is
 * an embedding-text template change, not a tokenizer change), so two table chunks under one lexical_version may hold different text. The
 * version pass cannot see that; this pass compares each current table chunk's stored text with the switch state and rewrites the ones that
 * differ, keeping the version. With the switch off on a database without the function nothing can have been serialized, so it is skipped.
 */
async function tablePass(
  input: { db: RpcClient; signal: AbortSignal; batchSize: number; tenantKey: string | null; rows: RowSerialization; write: boolean },
  onPage: (written: number, candidates: TableCandidate[], stale: BatchRow[]) => Promise<void>,
): Promise<number | null> {
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const candidates = await listTableCandidates(input.db, input.signal, after, input.batchSize, input.tenantKey);
    if (candidates === null) {
      if (input.rows.enabled) throw new RelexInputError(`rpc_failed:${TABLE_CANDIDATES_RPC}`, 'PGRST202');
      return null;
    }
    if (candidates.length === 0) break;
    const stale = staleTableRows(candidates, input.rows);
    const written = input.write ? await writeBatch(input.db, input.signal, stale) : stale.length;
    total += written;
    await onPage(written, candidates, stale);
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < input.batchSize) break;
  }
  return total;
}

async function writeBatch(db: RpcClient, signal: AbortSignal, rows: BatchRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await callRpc(db, signal, 'rag_relex_batch', { p_rows: rows, p_version: LEXICAL_VERSION });
  const count = result[0]?.rag_relex_batch;
  return typeof count === 'number' ? count : Number(count ?? 0);
}

/**
 * Rebuilds lexical_text for every ready current chunk whose lexical_version differs from LEXICAL_VERSION, in
 * keyset batches, without parser, sidecar, object-store or embedding calls.
 */
export async function runRelex(input: RunRelexInput): Promise<RelexReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  let updated = 0;
  let batches = 0;
  const rowSerialization = rowSerializationOf(input.tableRowSerialization);

  input.onProgress?.(
    `started: version ${LEXICAL_VERSION}, batch size ${batchSize}${tenantKey ? `, tenant ${tenantKey}` : ', all tenants'}${after ? `, resume after ${after}` : ''}`,
  );

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listCandidates(input.db, signal, after, batchSize, tenantKey);
    if (candidates.length === 0) break;

    const rows = candidates.map((candidate) => batchRow(candidate, rowSerialization));
    const written = await writeBatch(input.db, signal, rows);
    batches += 1;
    updated += written;
    for (const candidate of candidates) {
      tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
    }
    const cursor = candidates[candidates.length - 1]?.id ?? after ?? '';
    await input.onBatch?.({ batch: batches, updated: written, cursor });
    input.onProgress?.(`batch ${batches}: updated ${written} (total ${updated})`);
    after = cursor;
    if (candidates.length < batchSize) break;
  }

  if (rowSerialization === null) {
    input.onProgress?.(`done: ${updated} rows in ${batches} batches`);
    return { updated, batches, tenants };
  }

  const tables = await tablePass(
    { db: input.db, signal, batchSize, tenantKey, rows: rowSerialization, write: true },
    async (written, candidates, stale) => {
      if (stale.length === 0) return;
      batches += 1;
      updated += written;
      for (const row of stale) {
        const tenant = candidates.find((candidate) => candidate.id === row.id)?.tenant_key;
        if (tenant) tenants[tenant] = (tenants[tenant] ?? 0) + 1;
      }
      input.onProgress?.(`table batch: rewrote ${written} table chunks (total ${updated})`);
    },
  );
  if (tables === null) input.onProgress?.('table pass skipped: rag_relex_table_candidates is not installed (migration 0815)');
  input.onProgress?.(`done: ${updated} rows in ${batches} batches`);
  return { updated, batches, tenants, tables: tables ?? 0 };
}

/** Counts stale chunks per tenant without writing. */
export async function dryRunRelex(input: DryRunRelexInput): Promise<DryRunRelexReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  const counted = new Set<string>();
  let total = 0;

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listCandidates(input.db, signal, after, batchSize, tenantKey);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
      counted.add(candidate.id);
      total += 1;
    }
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < batchSize) break;
  }

  const rowSerialization = rowSerializationOf(input.tableRowSerialization);
  if (rowSerialization === null) return { tenants, total };
  // A chunk the version pass already counts is rewritten there with the switch applied, so the table pass would not touch it again.
  let tables = 0;
  const installed = await tablePass({ db: input.db, signal, batchSize, tenantKey, rows: rowSerialization, write: false }, async (_count, candidates, stale) => {
    for (const row of stale) {
      if (counted.has(row.id)) continue;
      const tenant = candidates.find((candidate) => candidate.id === row.id)?.tenant_key;
      if (tenant) tenants[tenant] = (tenants[tenant] ?? 0) + 1;
      tables += 1;
    }
  });
  return { tenants, total: total + (installed === null ? 0 : tables), tables: installed === null ? 0 : tables };
}