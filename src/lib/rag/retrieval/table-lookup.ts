import { versionAndIdentifierArgs } from '../backend/pgvector';
import { RetrievalBackendError, rpcRows, type RpcClient } from '../backend/supabase-rpc';
import type { VersionScope } from '../backend/types';
import { queryLexicalTokens } from '../lexical/tokenize';
import { assertTenantScope, scopeKey, type TenantScope } from '../tenant/scope';
import type { TableLookupParams } from '@/lib/rag-eval/contracts.generated';

const RPC_NAME = 'rag_table_lookup';
export const MAX_TABLE_LOOKUP_TOKENS = 64;
const MAX_LOOKUP_LIMIT = 50;
const MAX_MIN_CELLS = 10;

export interface TableLookupRow {
  row_id: string;
  document_id: string;
  table_key: string;
  row_index: number;
  header: string[];
  cells: Record<string, string>;
  matched_cells: number;
  chunk_ids: string[];
}

export interface TableLookupOptions {
  client: RpcClient;
  signal: AbortSignal;
  /** Passed through to the SQL function only when set; 'current' sends nothing. */
  versionScope?: VersionScope;
  identifiersNorm?: string[];
}

export interface TableLookupStageResult {
  rows: TableLookupRow[];
  tokenCount: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function toRow(raw: unknown): TableLookupRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.row_id !== 'string' || typeof row.document_id !== 'string' || typeof row.table_key !== 'string') return null;
  if (typeof row.row_index !== 'number' || !Number.isInteger(row.row_index) || row.row_index < 0) return null;
  if (typeof row.matched_cells !== 'number' || !Number.isInteger(row.matched_cells)) return null;
  if (!isStringArray(row.chunk_ids) || row.chunk_ids.length === 0) return null;
  if (!isStringArray(row.header)) return null;
  if (typeof row.cells !== 'object' || row.cells === null || Array.isArray(row.cells)) return null;
  const cells: Record<string, string> = {};
  for (const [name, value] of Object.entries(row.cells as Record<string, unknown>)) {
    if (typeof value === 'string') cells[name] = value;
  }
  return {
    row_id: row.row_id,
    document_id: row.document_id,
    table_key: row.table_key,
    row_index: row.row_index,
    header: [...row.header],
    cells,
    matched_cells: row.matched_cells,
    chunk_ids: [...row.chunk_ids],
  };
}

function clamp(value: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Table rows of the scope's tenant in which at least min_cells distinct cells consist of query tokens only. The tenant key is the scope's
 * and nothing else, the tokens travel as one text[] parameter (never SQL text), and the SQL function repeats the tenant, chunking-profile,
 * status and version predicates. No tokens, no call.
 */
export async function tableLookup(
  scope: TenantScope,
  tokens: readonly string[],
  params: Pick<TableLookupParams, 'min_cells' | 'limit'>,
  options: TableLookupOptions,
): Promise<TableLookupRow[]> {
  assertTenantScope(scope);
  const values = [...new Set(tokens.filter((token) => token.length > 0))].slice(0, MAX_TABLE_LOOKUP_TOKENS);
  if (values.length === 0) return [];
  const { client, signal } = options;
  signal.throwIfAborted();
  const response = await client
    .rpc(RPC_NAME, {
      p_tenant_key: scopeKey(scope).toLowerCase(),
      p_tokens: values,
      p_min_cells: clamp(params.min_cells, MAX_MIN_CELLS),
      p_limit: clamp(params.limit, MAX_LOOKUP_LIMIT),
      ...versionAndIdentifierArgs(options.versionScope, options.identifiersNorm),
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new RetrievalBackendError(RPC_NAME, response.error.code ?? null);
  return rpcRows(response.data).map(toRow).filter((row): row is TableLookupRow => row !== null);
}

/** Tokenizes the question with the lexical query tokenizer and looks the tokens up; a question without tokens costs no call. */
export async function tableLookupStage(
  query: string,
  scope: TenantScope,
  params: Pick<TableLookupParams, 'min_cells' | 'limit'>,
  options: TableLookupOptions,
): Promise<TableLookupStageResult> {
  const tokens = queryLexicalTokens(query).slice(0, MAX_TABLE_LOOKUP_TOKENS);
  if (tokens.length === 0) return { rows: [], tokenCount: 0 };
  return { rows: await tableLookup(scope, tokens, params, options), tokenCount: tokens.length };
}
