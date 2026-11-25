import type { SupabaseClient } from '@supabase/supabase-js';
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

  const documentResult = await adminClient
    .from('documents')
    .select('id, filename, created_at, content, metadata')
    .in('id', documentIds)
    .abortSignal(signal);
  signal.throwIfAborted();
  if (documentResult.error) throw new Error(`[RAG Assemble] documents lookup failed: ${documentResult.error.message}`);

  const chunkResult = await adminClient.from('document_chunks').select('id, metadata').in('id', chunkIds).abortSignal(signal);
  signal.throwIfAborted();
  if (chunkResult.error) throw new Error(`[RAG Assemble] chunk metadata lookup failed: ${chunkResult.error.message}`);

  for (const row of (documentResult.data ?? []) as AssemblyDocumentRow[]) {
    documents.set(row.id, row);
  }
  for (const row of (chunkResult.data ?? []) as Array<{ id: string; metadata: Record<string, any> | null }>) {
    chunkMetadata.set(row.id, row.metadata ?? null);
  }

  return { documents, chunkMetadata };
}
