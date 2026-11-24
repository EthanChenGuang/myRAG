import type { RpcClient } from '../../backend/supabase-rpc';
import { detectLanguage } from '../../lang/detect';
import { LEXICAL_VERSION, chunkLexicalText } from '../../lexical/chunk-text';
import { isTenantKey } from '../writer';

/** Bad arguments or limits; nothing was written. */
export class RelexInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`[RAG Relex] ${code}`);
    this.name = 'RelexInputError';
    this.code = code;
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
}

export interface RelexReport {
  updated: number;
  batches: number;
  tenants: Record<string, number>;
}

export interface DryRunRelexInput {
  db: RpcClient;
  tenantKey?: string | null;
  batchSize?: number;
  resumeAfter?: string | null;
  signal?: AbortSignal;
}

export interface DryRunRelexReport {
  tenants: Record<string, number>;
  total: number;
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
  if (response.error) throw new RelexInputError(`rpc_failed:${rpc}`);
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

function batchRow(candidate: RelexCandidate): { id: string; lexical_text: string; language?: string } {
  const lexical_text = chunkLexicalText({
    sectionPath: candidate.section_path,
    content: candidate.content,
    chunkKind: candidate.chunk_kind,
    metadata: candidate.metadata,
    documentFilename: candidate.document_filename,
  });
  const row: { id: string; lexical_text: string; language?: string } = { id: candidate.id, lexical_text };
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

async function writeBatch(db: RpcClient, signal: AbortSignal, rows: Array<{ id: string; lexical_text: string; language?: string }>): Promise<number> {
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

  input.onProgress?.(
    `started: version ${LEXICAL_VERSION}, batch size ${batchSize}${tenantKey ? `, tenant ${tenantKey}` : ', all tenants'}${after ? `, resume after ${after}` : ''}`,
  );

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listCandidates(input.db, signal, after, batchSize, tenantKey);
    if (candidates.length === 0) break;

    const rows = candidates.map(batchRow);
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

  input.onProgress?.(`done: ${updated} rows in ${batches} batches`);
  return { updated, batches, tenants };
}

/** Counts stale chunks per tenant without writing. */
export async function dryRunRelex(input: DryRunRelexInput): Promise<DryRunRelexReport> {
  const signal = input.signal ?? new AbortController().signal;
  const batchSize = checkBatchSize(input.batchSize);
  const tenantKey = checkTenantKey(input.tenantKey);
  let after = input.resumeAfter ?? null;
  const tenants: Record<string, number> = {};
  let total = 0;

  for (;;) {
    signal.throwIfAborted();
    const candidates = await listCandidates(input.db, signal, after, batchSize, tenantKey);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      tenants[candidate.tenant_key] = (tenants[candidate.tenant_key] ?? 0) + 1;
      total += 1;
    }
    after = candidates[candidates.length - 1]?.id ?? after;
    if (candidates.length < batchSize) break;
  }

  return { tenants, total };
}