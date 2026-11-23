import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantScope } from '../tenant/scope';
import type { DocumentPartRef, ReferencedState } from '../types';

export interface ResolveDocumentRefsInput {
  scope: TenantScope;
  mentions: string[];
  documentParts: DocumentPartRef[];
  admin: SupabaseClient;
  signal: AbortSignal;
}

export interface ResolvedDocumentRefs extends ReferencedState {
  ignored: number;
}

export async function resolveDocumentRefs(_input: ResolveDocumentRefsInput): Promise<ResolvedDocumentRefs> {
  return { usedDocuments: [], context: '', ignored: 0 };
}
