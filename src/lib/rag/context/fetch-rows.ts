import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssemblyCandidate, AssemblyDocumentRow } from './assemble';

export interface AssemblyRows {
  documents: Map<string, AssemblyDocumentRow>;
  chunkMetadata: Map<string, Record<string, any> | null>;
}

export interface FetchAssemblyRowsOptions {
  adminClient: SupabaseClient;
  signal: AbortSignal;
}

export async function fetchAssemblyRows(
  _candidates: AssemblyCandidate[],
  _options: FetchAssemblyRowsOptions,
): Promise<AssemblyRows> {
  return { documents: new Map(), chunkMetadata: new Map() };
}
