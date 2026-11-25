import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';

export interface CitationDisplayEntry {
  n: number;
  documentName: string;
  page: number | null;
  sectionPath: string[] | null;
  quote: string;
  linkDocumentId: string | null;
  unavailable: boolean;
}

export function citationDisplayEntries(
  _citations: readonly CitationRecord[],
  _documents: Readonly<Record<string, 'current' | 'unavailable'>>,
): CitationDisplayEntry[] {
  return [];
}
