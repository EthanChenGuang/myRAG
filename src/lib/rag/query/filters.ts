import type { RetrievalFilterInput, RetrievalFilters } from '@/lib/rag/backend/types';

export function parseRetrievalFilters(
  _body: unknown
): { ok: true; filters?: RetrievalFilterInput } | { ok: false; details: { path: string; message: string }[] } {
  return { ok: false, details: [] };
}

export function buildRetrievalFilters(_input: {
  explicit?: RetrievalFilterInput;
  referencedDocumentIds: string[];
}): RetrievalFilters {
  return { currentOnly: true };
}