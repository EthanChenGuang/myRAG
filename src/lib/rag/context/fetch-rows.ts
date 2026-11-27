import type { SupabaseClient } from '@supabase/supabase-js';
import { readAnswerConfig } from '../generation/answer-config';
import type { AssemblyCandidate, AssemblyDocumentRow } from './assemble';

export interface AssemblyRows {
  /**
   * Rows read under the caller's scope (the ids come from scoped candidates). `metadata` carries
   * metadata.quarantine (rule_ids, released_rule_ids, released_at), which releasedRulesFromRows turns into the
   * per-version released rule ids for injection_check without another query.
   */
  documents: Map<string, AssemblyDocumentRow>;
  chunkMetadata: Map<string, Record<string, any> | null>;
}

export interface FetchAssemblyRowsOptions {
  adminClient: SupabaseClient;
  signal: AbortSignal;
}

const DOCUMENT_BASE_SELECT = 'id, filename, created_at, content, metadata';

/** D-49: read only while RAG_VERSION_LABELS is on; effective_from needs 0801 and version_label 0941. */
export const VERSION_LABEL_COLUMNS = ['version', 'doc_type', 'doc_date', 'effective_from', 'version_label'] as const;

export const VERSION_LABELS_MIGRATION_WARNING =
  '[Answer Rules] RAG_VERSION_LABELS is on but the documents table lacks a version column; apply migrations 0801 and 0941. Context is assembled without version labels.';

let versionColumnsWarned = false;

/**
 * The base columns, plus user_id (the uploader, D-44) only while RAG_SECURITY_EVENTS is on and the version columns only while
 * RAG_VERSION_LABELS is on, so the all-off request is unchanged.
 */
export function assemblyDocumentSelect(options: { versionColumns?: boolean } = {}): string {
  const config = readAnswerConfig();
  const optional: string[] = [];
  if (config.securityEvents) optional.push('user_id');
  if ((options.versionColumns ?? true) && config.versionLabels) optional.push(...VERSION_LABEL_COLUMNS);
  return optional.length > 0 ? `${DOCUMENT_BASE_SELECT}, ${optional.join(', ')}` : DOCUMENT_BASE_SELECT;
}

/** PostgREST and Postgres report a column the database does not have as 42703 or "column ... does not exist". */
export function isUnknownColumnError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  return /column [^ ]+ does not exist/i.test(error.message ?? '');
}

/** One warning per process (RESEARCH Pitfall 15); it names the migrations, never a value. */
export function warnVersionColumnsMissing(): void {
  if (versionColumnsWarned) return;
  versionColumnsWarned = true;
  console.warn(VERSION_LABELS_MIGRATION_WARNING);
}

export function resetVersionColumnsWarningForTests(): void {
  versionColumnsWarned = false;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export async function fetchAssemblyRows(
  candidates: AssemblyCandidate[],
  { adminClient, signal }: FetchAssemblyRowsOptions,
): Promise<AssemblyRows> {
  const documents = new Map<string, AssemblyDocumentRow>();
  const chunkMetadata = new Map<string, Record<string, any> | null>();
  if (candidates.length === 0) return { documents, chunkMetadata };

  const documentIds = unique(candidates.map((candidate) => candidate.document_id));
  const chunkIds = unique(candidates.map((candidate) => candidate.chunk_id));

  const select = assemblyDocumentSelect();
  let documentResult = await adminClient.from('documents').select(select).in('id', documentIds).abortSignal(signal);
  signal.throwIfAborted();
  const fallback = assemblyDocumentSelect({ versionColumns: false });
  if (documentResult.error && select !== fallback && isUnknownColumnError(documentResult.error)) {
    warnVersionColumnsMissing();
    documentResult = await adminClient.from('documents').select(fallback).in('id', documentIds).abortSignal(signal);
    signal.throwIfAborted();
  }
  if (documentResult.error) throw new Error(`[RAG Assemble] documents lookup failed: ${documentResult.error.message}`);

  const chunkResult = await adminClient.from('document_chunks').select('id, metadata').in('id', chunkIds).abortSignal(signal);
  signal.throwIfAborted();
  if (chunkResult.error) throw new Error(`[RAG Assemble] chunk metadata lookup failed: ${chunkResult.error.message}`);

  for (const row of (documentResult.data ?? []) as unknown as AssemblyDocumentRow[]) {
    documents.set(row.id, row);
  }
  for (const row of (chunkResult.data ?? []) as Array<{ id: string; metadata: Record<string, any> | null }>) {
    chunkMetadata.set(row.id, row.metadata ?? null);
  }

  return { documents, chunkMetadata };
}

export type VersionColumns = Pick<AssemblyDocumentRow, 'version' | 'doc_type' | 'doc_date' | 'effective_from' | 'version_label'>;

/**
 * v2 builds its document rows from the search hits, which carry no version label or dates. While RAG_VERSION_LABELS is on it
 * reads the five columns in one batched read of the request's documents, restricted to the request's tenant key. A missing
 * column warns once and returns nothing; any other failure returns nothing too, so assembly continues without labels.
 */
export async function fetchVersionColumns(
  adminClient: SupabaseClient,
  documentIds: string[],
  { tenantKey, signal }: { tenantKey: string; signal: AbortSignal },
): Promise<Map<string, VersionColumns>> {
  const out = new Map<string, VersionColumns>();
  if (documentIds.length === 0) return out;
  const { data, error } = await adminClient
    .from('documents')
    .select(`id, ${VERSION_LABEL_COLUMNS.join(', ')}`)
    .eq('tenant_key', tenantKey)
    .in('id', unique(documentIds))
    .abortSignal(signal);
  signal.throwIfAborted();
  if (error) {
    if (isUnknownColumnError(error)) warnVersionColumnsMissing();
    else console.warn('[RAG Context] version columns lookup failed', { code: error.code ?? 'unknown' });
    return out;
  }
  for (const row of (data ?? []) as unknown as Array<VersionColumns & { id: string }>) {
    const { id, ...columns } = row;
    out.set(id, columns);
  }
  return out;
}
